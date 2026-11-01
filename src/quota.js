'use strict';

/**
 * Quota probe.
 *
 * Sends one tiny request per account and reads the rate-limit headers the
 * provider returns, so you can see the real headroom instead of guessing.
 *
 * It also answers the question every "pool my free keys" project gets wrong:
 * are these keys separate pools, or one shared pool?
 * Groq documents that limits apply per *organisation* — several keys created
 * in the same account share a single budget, so rotation across them adds
 * exactly nothing. We detect that by comparing the remaining-request counters
 * of sequentially probed keys: inside one shared pool the counter drops by one
 * per probe, so (remaining + calls_so_far) stays constant.
 */

const { upstreamUrl, buildHeaders } = require('./providers');

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

const UNIT_MS = { ms: 1, s: 1000, m: 60 * 1000, h: 3600 * 1000, d: 24 * 3600 * 1000 };

function resetMs(value) {
  if (!value) return null;
  const raw = String(value).trim();
  let ms = null;
  // "2m59.56s", "1h2m", "750ms" — units can be combined, just add them up
  const combined = raw.match(/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/);
  if (combined) {
    const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
    let total = 0;
    let m;
    while ((m = re.exec(raw)) !== null) total += parseFloat(m[1]) * UNIT_MS[m[2]];
    ms = total;
  } else if (/^\d+(\.\d+)?$/.test(raw)) ms = parseFloat(raw) * 1000;
  else if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(raw)) {
    const parts = raw.split(':').map(Number).reverse();
    ms = ((parts[2] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[0] || 0)) * 1000;
  } else if (!Number.isNaN(Date.parse(raw))) ms = Date.parse(raw) - Date.now();
  if (ms == null || !Number.isFinite(ms)) return null;
  return Math.max(0, Math.round(ms));
}

function readLimits(headers) {
  const get = (name) => (headers && typeof headers.get === 'function' ? headers.get(name) : null);
  const requests = {
    limit: num(get('x-ratelimit-limit-requests')),
    remaining: num(get('x-ratelimit-remaining-requests')),
    resetMs: resetMs(get('x-ratelimit-reset-requests')),
  };
  const tokens = {
    limit: num(get('x-ratelimit-limit-tokens')),
    remaining: num(get('x-ratelimit-remaining-tokens')),
    resetMs: resetMs(get('x-ratelimit-reset-tokens')),
  };
  const retryAfterMs = resetMs(get('retry-after'));
  const any = [requests.limit, requests.remaining, tokens.limit, tokens.remaining].some((v) => v != null);
  return { requests, tokens, retryAfterMs, present: any };
}

/**
 * Probe one account.
 * @returns {Promise<{ok:boolean, status:string, detail?:string, limits?:object, model:string, latencyMs?:number}>}
 */
async function probeQuota(provider, account, opts = {}) {
  const model = opts.model || (Array.isArray(provider.models) && provider.models[0]) || 'llama-3.1-8b-instant';
  const timeoutMs = Number(opts.timeoutMs) || 20000;

  let path = '/v1/chat/completions';
  let payload;
  if (provider.protocol === 'anthropic') {
    path = '/v1/messages';
    payload = { model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };
  } else {
    payload = { model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };
  }

  const url = upstreamUrl(provider, path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(provider, account.key, payload, {}),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const limits = readLimits(res.headers);
    if (res.ok) {
      clearTimeout(timer);
      // drain the tiny body so the socket is released
      await res.text().catch(() => '');
      return { ok: true, status: 'ok', limits, model, latencyMs };
    }
    const text = await res.text().catch(() => '');
    clearTimeout(timer);
    let detail = `HTTP ${res.status}`;
    try {
      const json = JSON.parse(text);
      detail = (json.error && (json.error.message || json.error)) || json.message || detail;
    } catch { /* not json */ }
    const status = res.status === 429 ? 'rate-limited' : res.status === 401 || res.status === 403 ? 'invalid-key' : 'error';
    return { ok: false, status, detail: String(detail).slice(0, 200), limits, model, latencyMs };
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      status: 'error',
      detail: controller.signal.aborted ? 'timed out' : `network error: ${err.message}`,
      model,
      latencyMs: Date.now() - started,
    };
  }
}

/**
 * Group probed rows and decide whether they share a quota pool.
 * `order` is the probe order inside the group (0-based).
 */
function analysePools(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.limits || row.limits.requests.remaining == null) continue;
    const key = `${row.provider}::${row.model}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const pools = [];
  for (const [key, members] of groups) {
    const [provider, model] = key.split('::');
    // One shared pool => every extra probe costs exactly one request, so the
    // remaining counter drops by exactly 1 between consecutive accounts.
    // Separate pools each drop from their own counter, so it does NOT drop.
    const drops = members.slice(1).every((row, i) => row.limits.requests.remaining === members[i].limits.requests.remaining - 1);
    const shared = members.length > 1 && drops;
    pools.push({
      provider,
      model,
      accounts: members.length,
      shared,
      confidence: members.length > 1 ? 'high' : 'n/a',
      requestsLimit: Math.max(...members.map((r) => r.limits.requests.limit || 0)) || null,
      requestsLeft: Math.min(...members.map((r) => r.limits.requests.remaining)),
      pools: shared ? 1 : members.length,
    });
  }
  return pools;
}

module.exports = { probeQuota, analysePools, readLimits, resetMs };
