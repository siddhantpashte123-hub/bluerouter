'use strict';

/**
 * Router / proxy core.
 *
 * One client request can fan out across many accounts from many providers:
 *   pick best account -> call upstream -> 429/5xx? cool the account down and
 *   instantly retry the next account, transparently to the client.
 */

const { Readable } = require('stream');
const {
  getProvider,
  allProviders,
  upstreamUrl,
  buildHeaders,
  needsAudio,
  supportsAudio,
  normalizeModel,
  adaptBody,
} = require('./providers');
const { StreamMeter, AnthropicStream, toAnthropic, fromAnthropic } = require('./adapters');
const { promptText, truncate, estimateTokens, iso } = require('./util');

const RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);
const MAX_ERROR_BODY = 64 * 1024;

const sticky = new Map(); // provider -> account id that worked last

function resetSticky() {
  sticky.clear();
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

function openaiError(message, { type = 'upstream_error', code = null, status = 502, details = null, tried = null } = {}) {
  return {
    status,
    body: {
      error: {
        message: String(message || 'Upstream request failed').slice(0, 2000),
        type,
        code,
        ...(tried ? { tried } : {}),
      },
      ...(details ? { details } : {}),
    },
  };
}

function extractErrorMessage(text, statusText) {
  if (!text) return statusText || 'Upstream error';
  try {
    const json = JSON.parse(text);
    if (typeof json.error === 'string') return json.error;
    if (json.error && json.error.message) return json.error.message;
    if (json.message) return json.message;
    if (Array.isArray(json)) return JSON.stringify(json[0]).slice(0, 300);
  } catch { /* not json */ }
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 300) || statusText || 'Upstream error';
}

function retryAfterMs(headers) {
  if (!headers) return 0;
  const raw = headers.get('retry-after') || headers.get('x-ratelimit-reset-tokens') || headers.get('x-ratelimit-reset-requests');
  if (!raw) return 0;
  let ms = 0;
  if (/^\d+(\.\d+)?$/.test(raw)) ms = parseFloat(raw) * 1000;
  else if (/^\d+(\.\d+)?s$/.test(raw)) ms = parseFloat(raw) * 1000;
  else if (/^\d+(\.\d+)?m$/.test(raw)) ms = parseFloat(raw) * 60 * 1000;
  else if (/^\d+(\.\d+)?h$/.test(raw)) ms = parseFloat(raw) * 3600 * 1000;
  else if (!Number.isNaN(Date.parse(raw))) ms = Date.parse(raw) - Date.now();
  if (!Number.isFinite(ms)) return 0;
  return Math.min(Math.max(ms, 2000), 6 * 3600 * 1000);
}

/** Decide what to do with a failed upstream response. */
function classifyFailure(status, text, headers, baseCooldownMs = 5 * 60 * 1000) {
  const message = extractErrorMessage(text);
  const lower = message.toLowerCase();
  const daily = /per day|tpd|daily|quota|credits|insufficient/.test(lower);

  if (status === 429) {
    const headerWait = retryAfterMs(headers);
    const configured = Math.min(Math.max(Number(baseCooldownMs) || 0, 20 * 1000), 6 * 3600 * 1000);
    const cooldownMs = daily
      ? Math.min(Math.max(headerWait, 30 * 60 * 1000, configured), 6 * 3600 * 1000)
      : Math.min(Math.max(headerWait, configured), 15 * 60 * 1000);
    return {
      retry: true,
      cooldownMs,
      scope: 'model',
      reason: 'rate-limit',
      message,
      status,
      daily,
    };
  }
  if (status === 401 || status === 403) {
    return { retry: true, cooldownMs: 6 * 3600 * 1000, scope: 'all', reason: 'auth', message, status, fatal: true };
  }
  if (status === 404) {
    return { retry: true, cooldownMs: 0, scope: 'model', reason: 'model-not-found', message, status, soft: true };
  }
  if (status === 400 || status === 405 || status === 422) {
    return { retry: false, cooldownMs: 0, reason: 'bad-request', message, status, soft: true };
  }
  if (status === 408 || status === 409 || status === 425) {
    return { retry: true, cooldownMs: 10 * 1000, scope: 'all', reason: 'transient', message, status };
  }
  if (status === 402 || status === 413) {
    return { retry: false, cooldownMs: 0, reason: 'upstream', message, status, soft: true };
  }
  if (RETRY_STATUSES.has(status) || status >= 500) {
    return { retry: true, cooldownMs: 30 * 1000, scope: 'all', reason: 'upstream-down', message, status };
  }
  return { retry: false, cooldownMs: 0, reason: 'upstream', message, status };
}

/* ------------------------------------------------------------------ */
/* Target resolution                                                   */
/* ------------------------------------------------------------------ */

/**
 * Figure out which providers to try, in order.
 * Supports explicit targeting:  model = "groq/llama-3.3-70b-versatile"
 *                               header/query provider=groq
 */
function resolveTargets(store, { model, forcedProvider, requireAudio }) {
  const cfg = store.get();
  let providerId = forcedProvider ? String(forcedProvider).toLowerCase() : null;
  let resolvedModel = model;

  if (!providerId && typeof model === 'string' && model.includes('/')) {
    const slash = model.indexOf('/');
    const prefix = model.slice(0, slash).toLowerCase();
    const rest = model.slice(slash + 1);
    const prov = getProvider(prefix, cfg);
    if (prov && Array.isArray(prov.models) && prov.models.some((m) => m.toLowerCase() === rest.toLowerCase())) {
      providerId = prefix;
      resolvedModel = rest;
    }
  }

  const counts = {};
  for (const k of store.keys()) {
    if (!k.enabled) continue;
    counts[k.provider] = (counts[k.provider] || 0) + 1;
  }

  const usable = allProviders(cfg).filter((p) => {
    if (!p.enabled) return false;
    if (!counts[p.id]) return false;
    if (requireAudio && !supportsAudio(p)) return false;
    return true;
  });

  if (providerId) {
    const exact = usable.find((p) => p.id === providerId);
    if (!exact) {
      const known = getProvider(providerId, cfg);
      const reason = !known ? `Unknown provider "${providerId}"`
        : !known.enabled ? `Provider "${providerId}" is disabled`
          : !counts[providerId] ? `No enabled accounts for "${providerId}"`
            : `"${providerId}" cannot handle audio requests`;
      return { error: reason, targets: [], model: resolvedModel, providerId };
    }
    return { targets: [exact], model: normalizeModel(exact, resolvedModel), providerId };
  }

  const supports = (p) => p.models.some((m) => String(m).toLowerCase() === String(resolvedModel).toLowerCase());
  usable.sort((a, b) => {
    const sa = supports(a) ? 0 : 1;
    const sb = supports(b) ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const ca = counts[a.id] || 0;
    const cb = counts[b.id] || 0;
    return cb - ca;
  });

  return { targets: usable, model: resolvedModel, providerId: null };
}

function listModels(store) {
  const cfg = store.get();
  const active = new Set(store.keys().filter((k) => k.enabled).map((k) => k.provider));
  const seen = new Map();
  for (const p of allProviders(cfg)) {
    if (!p.enabled || !active.has(p.id)) continue;
    for (const m of p.models || []) {
      if (!seen.has(m)) {
        seen.set(m, {
          id: p.id === 'openrouter' || p.id === 'custom' || p.models.includes(m) ? m : `${p.id}/${m}`,
          object: 'model',
          created: Math.floor(Date.parse(cfg.createdAt || iso()) / 1000) || Math.floor(Date.now() / 1000),
          owned_by: p.id,
        });
      }
    }
  }
  return [...seen.values()];
}

/* ------------------------------------------------------------------ */
/* Raw call to one upstream account                                    */
/* ------------------------------------------------------------------ */

async function callUpstream({
  store,
  provider,
  account,
  model,
  openaiPath,
  body,
  raw,
  contentType,
  req,
  timeoutMs,
}) {
  const cfg = store.get();
  const isMultipart = contentType && contentType.includes('multipart/form-data');
  const url = upstreamUrl(provider, openaiPath);
  let payload;
  let outBody = body;
  let outModel = model;

  if (raw) {
    payload = raw;
  } else {
    outModel = normalizeModel(provider, model);
    if (provider.protocol === 'anthropic') {
      outBody = toAnthropic(body || {}, outModel);
    } else {
      outBody = adaptBody(provider, body || {}, outModel);
    }
    payload = Buffer.from(JSON.stringify(outBody));
  }

  const headers = buildHeaders(provider, account.key, outBody, req.headers);
  if (isMultipart) headers['content-type'] = contentType;
  if (isMultipart) delete headers.accept;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('BlueRouter upstream timeout')), timeoutMs);
  const startedAt = Date.now();

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: payload,
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = controller.signal.aborted;
    const msg = aborted
      ? `Upstream timed out after ${Math.round(timeoutMs / 1000)}s`
      : `Network error: ${(err && err.cause && err.cause.message) || (err && err.message) || 'fetch failed'}`;
    return { error: { message: msg, status: 0, retryable: true, cooldownMs: 20 * 1000, reason: 'network' }, startedAt, url };
  }

  return {
    upstream,
    timer,
    controller,
    startedAt,
    url,
    outBody,
    outModel,
    isMultipart,
    clientWantsStream: !!(body && body.stream),
  };
}

/* ------------------------------------------------------------------ */
/* Main handler                                                        */
/* ------------------------------------------------------------------ */

/**
 * @param {object} opts
 * @param {import('http').IncomingMessage} opts.req
 * @param {import('http').ServerResponse} opts.res
 * @param {object} opts.store
 * @param {string} opts.openaiPath   e.g. "/v1/chat/completions"
 * @param {object} [opts.body]       parsed JSON body (if not raw)
 * @param {Buffer} [opts.raw]        raw body (multipart / audio)
 * @param {string} [opts.contentType]
 * @param {string} [opts.forcedProvider]
 */
async function proxyRequest(opts) {
  const { req, res, store, openaiPath, body = {}, raw = null, contentType = '', forcedProvider = null } = opts;
  const cfg = store.get();
  const routing = cfg.routing || {};
  const timeoutMs = Number(routing.timeoutMs) || 180000;
  const baseCooldown = Math.max(20 * 1000, (Number(routing.cooldownSeconds) || 300) * 1000);
  const exposeErrors = routing.exposeUpstreamErrors !== false;
  const errorText = (msg) => (exposeErrors ? msg : 'Upstream provider error (details hidden by routing.exposeUpstreamErrors)');
  const maxAttempts = Math.max(1, Math.min(6, Number(routing.maxRetries) || 3));
  const startedAt = Date.now();
  const wantStream = !!(body && body.stream) && !raw;
  const requireAudio = needsAudio(openaiPath, body);
  const requestedModel = (body && body.model) || '';
  const model = routing.forceModel || requestedModel;

  const targetsInfo = resolveTargets(store, { model, forcedProvider, requireAudio });
  if (targetsInfo.error) {
    const status = targetsInfo.error.startsWith('No enabled') || targetsInfo.error.startsWith('Provider') ? 503 : 400;
    return send(res, status, openaiError(targetsInfo.error, { type: 'configuration_error', code: 'no_route', status }).body);
  }
  const targets = targetsInfo.targets;
  if (!targets.length) {
    return send(res, 503, openaiError(
      requireAudio ? 'No audio-capable provider has an account yet.' : 'No accounts configured. Add one with: blue add groq <API_KEY>',
      { type: 'configuration_error', code: 'no_accounts', status: 503 },
    ).body);
  }

  const exclude = [];
  let lastFailure = null;
  const tried = [];
  let attempts = 0;

  while (attempts < maxAttempts) {
    // --- choose provider + account ----------------------------------
    let chosen = null;
    for (const provider of targets) {
      const pick = store.pickKey({
        provider: provider.id,
        model: targetsInfo.model,
        body,
        requireAudio,
        exclude,
      });
      if (!pick.key) continue;
      // sticky: reuse the last working account for prompt-cache warmth
      let key = pick.key;
      if (routing.mode === 'sticky') {
        const stickyId = sticky.get(provider.id);
        const candidate = stickyId && pick.list.find((k) => k.id === stickyId);
        if (candidate) key = candidate;
      }
      chosen = { provider, key, rejected: pick.rejected };
      break;
    }

    if (!chosen) {
      const message = exclude.length
        ? `All ${exclude.length} account(s) tried failed. Last error: ${errorText(lastFailure ? lastFailure.message : 'unknown')}`
        : 'No healthy account available right now (all are in cooldown or disabled). Try again later or run: blue status';
      const status = lastFailure ? lastFailure.status || 502 : 429;
      return send(res, status, openaiError(message, {
        type: 'no_account_available',
        code: 'accounts_exhausted',
        status,
        tried,
      }).body);
    }

    const { provider, key } = chosen;
    const rt = store.acquire(key);
    attempts += 1;
    tried.push({ provider: provider.id, account: key.name, accountId: key.id });

    const call = await callUpstream({
      store,
      provider,
      account: key,
      model: targetsInfo.model,
      openaiPath,
      body,
      raw,
      contentType,
      req,
      timeoutMs,
    });

    /* ---------------- network / transport failure ---------------- */
    if (call.error) {
      store.release(key);
      store.recordFailure(key, {
        status: 0,
        message: call.error.message,
        latencyMs: Date.now() - startedAt,
        cooldownMs: call.error.cooldownMs,
        scope: 'all',
        model: targetsInfo.model,
      });
      lastFailure = { ...call.error, status: 502 };
      exclude.push(key.id);
      logRequest(store, {
        provider: provider.id,
        account: key,
        model: targetsInfo.model,
        path: openaiPath,
        status: 502,
        ok: false,
        stream: wantStream,
        ms: Date.now() - startedAt,
        retries: attempts - 1,
        error: call.error.message,
        prompt: promptText(body),
      });
      continue;
    }

    /* ---------------- upstream responded ------------------------- */
    const { upstream } = call;
    const latencyMs = Date.now() - call.startedAt;

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      clearTimeout(call.timer);
      store.release(key);
      const failure = classifyFailure(upstream.status, text, upstream.headers, baseCooldown);
      store.recordFailure(key, {
        status: upstream.status,
        message: failure.message,
        latencyMs,
        cooldownMs: failure.cooldownMs,
        scope: failure.scope,
        model: targetsInfo.model,
        soft: !!failure.soft,
      });
      lastFailure = failure;

      logRequest(store, {
        provider: provider.id,
        account: key,
        model: targetsInfo.model,
        path: openaiPath,
        status: upstream.status,
        ok: false,
        stream: wantStream,
        ms: Date.now() - startedAt,
        latency: latencyMs,
        retries: attempts - 1,
        error: failure.message,
        prompt: promptText(body),
      });

      // 400-class errors will fail everywhere — don't burn accounts.
      if (!failure.retry) {
        return send(res, upstream.status, openaiError(errorText(failure.message), {
          type: 'upstream_error',
          code: failure.reason,
          status: upstream.status,
          tried,
        }).body);
      }
      if (failure.fatal) {
        // Bad key: cool it down, and keep trying other accounts.
        exclude.push(key.id);
        continue;
      }
      exclude.push(key.id);
      continue;
    }

    /* ---------------- success: stream ---------------------------- */
    const upstreamType = String(upstream.headers.get('content-type') || '');
    const upstreamIsSse = /event-stream/i.test(upstreamType);
    if (wantStream && upstream.body && (upstreamIsSse || provider.protocol === 'anthropic')) {
      clearTimeout(call.timer);
      const protocol = provider.protocol;
      const meter = protocol === 'anthropic'
        ? new AnthropicStream({ model: call.outModel })
        : new StreamMeter();

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-bluerouter-provider': provider.id,
        'x-bluerouter-account': headerSafe(key.name),
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      let finished = false;
      const done = (clientGone) => {
        if (finished) return;
        finished = true;
        clearTimeout(call.timer);
        const usage = meter.getUsage(body);
        const bytesOut = meter.bytes || 0;
        store.release(key, usage.total_tokens);
        if (!res.writableEnded) res.end();
        if (clientGone) {
          logRequest(store, {
            provider: provider.id, account: key, model: call.outModel, path: openaiPath,
            status: 499, ok: false, stream: true, ms: Date.now() - startedAt,
            retries: attempts - 1, error: 'client disconnected', prompt: promptText(body),
          });
          return;
        }
        sticky.set(provider.id, key.id);
        store.recordSuccess(key, {
          latencyMs,
          tokensIn: usage.prompt_tokens,
          tokensOut: usage.completion_tokens,
          bytesIn: 0,
          bytesOut,
          streamed: true,
        });
        logRequest(store, {
          provider: provider.id,
          account: key,
          model: call.outModel,
          path: openaiPath,
          status: 200,
          ok: true,
          stream: true,
          ms: Date.now() - startedAt,
          ttft: meter.firstTokenMs,
          latency: latencyMs,
          tokensIn: usage.prompt_tokens,
          tokensOut: usage.completion_tokens,
          tokensEstimated: !!usage.estimated,
          retries: attempts - 1,
          prompt: promptText(body),
        });
      };

      const source = Readable.fromWeb(upstream.body);
      source.on('error', (err) => {
        if (!res.writableEnded) res.destroy(err);
        done(true);
      });
      meter.on('error', (err) => {
        if (!res.writableEnded) res.destroy(err);
        done(true);
      });
      res.on('close', () => {
        if (!res.writableEnded) {
          call.controller.abort(new Error('client closed'));
          done(true);
        }
      });
      meter.on('end', () => done(false));
      source.pipe(meter).pipe(res, { end: false });
      return;
    }

    /* ---------------- success: binary (audio, files) ------------- */
    const looksJson = /json|event-stream|text\/plain/i.test(upstreamType);
    if (!looksJson && upstreamType) {
      const buf = Buffer.from(await upstream.arrayBuffer().catch(() => new ArrayBuffer(0)));
      clearTimeout(call.timer);
      store.release(key);
      sticky.set(provider.id, key.id);
      store.recordSuccess(key, { latencyMs, bytesOut: buf.length });
      logRequest(store, {
        provider: provider.id,
        account: key,
        model: call.outModel,
        path: openaiPath,
        status: 200,
        ok: true,
        stream: false,
        ms: Date.now() - startedAt,
        latency: latencyMs,
        retries: attempts - 1,
        prompt: promptText(body),
      });
      res.writeHead(200, {
        'content-type': upstreamType,
        'content-length': buf.length,
        'x-bluerouter-provider': provider.id,
        'x-bluerouter-account': headerSafe(key.name),
      });
      res.end(buf);
      return;
    }

    /* ---------------- success: buffered JSON --------------------- */
    const text = await upstream.text().catch(() => '');
    clearTimeout(call.timer);
    store.release(key);

    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* audio endpoints may answer with non-JSON (e.g. audio bytes) */
    }

    if (data && data.error) {
      const failure = classifyFailure(upstream.status || 502, text, upstream.headers, baseCooldown);
      store.recordFailure(key, {
        status: upstream.status,
        message: failure.message,
        latencyMs,
        cooldownMs: failure.cooldownMs,
        scope: failure.scope,
        model: targetsInfo.model,
        soft: !!failure.soft,
      });
      lastFailure = failure;
      exclude.push(key.id);
      continue;
    }

    const usage = data && data.usage
      ? {
        prompt_tokens: data.usage.prompt_tokens || 0,
        completion_tokens: data.usage.completion_tokens || 0,
        total_tokens: data.usage.total_tokens || 0,
      }
      : estimateTokens(body);

    const out = provider.protocol === 'anthropic' && data ? fromAnthropic(data, call.outModel) : data;
    const outUsage = out && out.usage && out.usage.total_tokens ? out.usage : usage;

    sticky.set(provider.id, key.id);
    store.recordSuccess(key, {
      latencyMs,
      tokensIn: outUsage.prompt_tokens || 0,
      tokensOut: outUsage.completion_tokens || 0,
      bytesIn: Number(req.headers['content-length']) || 0,
      bytesOut: Buffer.byteLength(text),
    });
    logRequest(store, {
      provider: provider.id,
      account: key,
      model: call.outModel,
      path: openaiPath,
      status: 200,
      ok: true,
      stream: false,
      ms: Date.now() - startedAt,
      latency: latencyMs,
      tokensIn: outUsage.prompt_tokens || 0,
      tokensOut: outUsage.completion_tokens || 0,
      tokensEstimated: !!usage.estimated,
      retries: attempts - 1,
      prompt: promptText(body),
    });

    const outText = out ? JSON.stringify(out) : text;
    res.writeHead(200, {
      'content-type': data ? 'application/json; charset=utf-8' : upstream.headers.get('content-type') || 'application/octet-stream',
      'content-length': Buffer.byteLength(outText),
      'x-bluerouter-provider': provider.id,
      'x-bluerouter-account': headerSafe(key.name),
    });
    res.end(outText);
    return;
  }

  /* -------------------- attempts exhausted ------------------------ */
  const status = lastFailure ? lastFailure.status || 502 : 502;
  return send(res, status, openaiError(
    attemptsMessage(attempts, lastFailure, errorText),
    { type: 'upstream_error', code: 'attempts_exhausted', status, tried },
  ).body);
}

function attemptsMessage(attempts, lastFailure, errorText) {
  const last = lastFailure ? errorText(lastFailure.message) : 'unknown';
  return `All ${attempts} attempt(s) failed. Last error: ${last}`;
}

function headerSafe(value) {
  return String(value == null ? '' : value).replace(/[^\x20-\x7E]/g, '').slice(0, 120) || 'account';
}

function send(res, status, payload) {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function logRequest(store, entry) {
  store.writeLog({
    ts: iso(),
    provider: entry.provider,
    accountId: entry.account ? entry.account.id : null,
    account: entry.account ? entry.account.name : null,
    model: entry.model || '',
    path: entry.path || '',
    status: entry.status,
    ok: !!entry.ok,
    stream: !!entry.stream,
    ms: entry.ms,
    latency: entry.latency,
    ttft: entry.ttft,
    tokensIn: entry.tokensIn || 0,
    tokensOut: entry.tokensOut || 0,
    tokensEstimated: !!entry.tokensEstimated,
    retries: entry.retries || 0,
    error: entry.error ? truncate(entry.error, 240) : null,
    prompt: entry.prompt ? truncate(entry.prompt, 70) : '',
  });
}

module.exports = {
  proxyRequest,
  resolveTargets,
  listModels,
  classifyFailure,
  callUpstream,
  resetSticky,
  send,
};
