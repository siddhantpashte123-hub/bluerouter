'use strict';

/**
 * BlueRouter HTTP server.
 *
 *   /                     dashboard (static)
 *   /v1/*                 OpenAI-compatible client API  (client key)
 *   /admin/*              management API                (admin token)
 *   /health               liveness probe                (public)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Store } = require('./store');
const { proxyRequest, listModels, send } = require('./proxy');
const {
  getProvider,
  allProviders,
  upstreamUrl,
  buildHeaders,
} = require('./providers');
const pkg = require('../package.json');
const { iso, maskKey, lanIp } = require('./util');

const DASH_DIR = path.join(__dirname, 'dashboard');
const JSON_LIMIT = 20 * 1024 * 1024;
const RAW_LIMIT = 64 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

function bearer(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return req.headers['x-api-key'] || req.headers['x-admin-token'] || '';
}

function tokenFrom(req, url) {
  return bearer(req) || url.searchParams.get('token') || '';
}

const failedLogins = new Map();

function tooManyFailures(ip) {
  const rec = failedLogins.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > 5 * 60 * 1000) {
    failedLogins.delete(ip);
    return false;
  }
  return rec.count >= 25;
}

function noteFailure(ip) {
  const rec = failedLogins.get(ip);
  if (!rec || Date.now() - rec.first > 5 * 60 * 1000) failedLogins.set(ip, { count: 1, first: Date.now() });
  else rec.count += 1;
}

/* ------------------------------------------------------------------ */
/* Body reading                                                        */
/* ------------------------------------------------------------------ */

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* Health check for one account                                        */
/* ------------------------------------------------------------------ */

async function checkAccount(store, account) {
  const cfg = store.get();
  const provider = getProvider(account.provider, cfg);
  if (!provider) {
    store.setHealth(account, { status: 'error', detail: 'Provider not configured' });
    return { ok: false, status: 'error', detail: 'Provider not configured' };
  }
  const url = upstreamUrl(provider, '/v1/models');
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(provider, account.key, null, {}),
      signal: controller.signal,
    });
    const ms = Date.now() - started;
    clearTimeout(timer);
    if (res.ok) {
      account.cooldownUntil = null;
      account.cooldownScope = null;
      account.lastError = null;
      store.setHealth(account, { status: 'ok', latencyMs: Math.round(ms), detail: 'Working' });
      return { ok: true, status: 'ok', latencyMs: ms };
    }
    const text = await res.text().catch(() => '');
    let detail = `HTTP ${res.status}`;
    try {
      const json = JSON.parse(text);
      detail = (json.error && (json.error.message || json.error)) || json.message || detail;
    } catch { /* ignore */ }
    const status = res.status === 401 || res.status === 403
      ? 'invalid-key'
      : res.status === 429 ? 'rate-limited' : 'error';
    if (status === 'invalid-key') {
      account.cooldownUntil = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
      account.cooldownScope = 'all';
    }
    store.setHealth(account, { status, latencyMs: Math.round(ms), detail: String(detail).slice(0, 240) });
    return { ok: false, status, latencyMs: ms, detail: String(detail).slice(0, 240) };
  } catch (err) {
    clearTimeout(timer);
    const detail = controller.signal.aborted ? 'Health check timed out' : `Network error: ${err.message}`;
    store.setHealth(account, { status: 'error', detail });
    return { ok: false, status: 'error', detail };
  }
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

function createServer(store) {
  const startedAt = Date.now();

  const server = http.createServer(async (req, res) => {
    const fakeBase = `http://${req.headers.host || 'localhost'}`;
    let url;
    try {
      url = new URL(req.url, fakeBase);
    } catch {
      return send(res, 400, { error: { message: 'Bad URL' } });
    }
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const ip = req.socket.remoteAddress || 'unknown';

    /* ------------------------------ CORS ------------------------------ */
    const isApi = p.startsWith('/v1') || p === '/health' || p.startsWith('/openai/v1');
    if (isApi) {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key, x-admin-token');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      res.setHeader('access-control-expose-headers', 'x-bluerouter-provider, x-bluerouter-account, retry-after');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
    }

    try {
      /* --------------------------- static UI -------------------------- */
      if (req.method === 'GET' && (p === '/' || p === '/dashboard' || p === '/index.html')) {
        return serveFile(res, path.join(DASH_DIR, 'index.html'));
      }
      if (req.method === 'GET' && (p === '/app.js' || p === '/styles.css' || p === '/favicon.svg' || p === '/logo.svg')) {
        return serveFile(res, path.join(DASH_DIR, p.slice(1)));
      }

      /* ----------------------------- health --------------------------- */
      if ((req.method === 'GET' || req.method === 'HEAD') && p === '/health') {
        return send(res, 200, {
          status: 'ok',
          name: 'bluerouter',
          instanceId: store.get().instanceId || null,
          version: pkg.version,
          uptime: Math.floor((Date.now() - startedAt) / 1000),
          accounts: store.keys().length,
          providers: [...new Set(store.keys().map((k) => k.provider))].length,
          port: store.get().port,
          time: iso(),
        });
      }

      /* --------------------------- public meta ------------------------ */
      if (req.method === 'GET' && p === '/api/meta') {
        const cfg = store.publicConfig();
        return send(res, 200, {
          name: 'BlueRouter',
          version: pkg.version,
          accounts: store.keys().length,
          activeAccounts: store.keys().filter((k) => k.enabled).length,
          providers: Object.values(cfg.providers).filter((x) => x.enabled).length,
          port: cfg.port,
        });
      }

      /* --------------------------- client API -------------------------- */
      const openaiPath = p.startsWith('/openai/v1')
        ? p.replace('/openai', '')
        : p.startsWith('/v1') ? p : null;

      if (openaiPath) {
        if (!store.checkClientKey(tokenFrom(req, url))) {
          noteFailure(ip);
          return send(res, 401, {
            error: {
              message: 'Invalid API key. Use your BlueRouter key (see: blue url) — not the provider key.',
              type: 'invalid_request_error',
              code: 'invalid_api_key',
            },
          });
        }

        if (req.method === 'GET' && openaiPath === '/v1/models') {
          const forced = url.searchParams.get('provider');
          let models = listModels(store);
          if (forced) models = models.filter((m) => m.owned_by === forced);
          return send(res, 200, { object: 'list', data: models });
        }
        if (req.method === 'GET' && openaiPath.startsWith('/v1/models/')) {
          const id = decodeURIComponent(openaiPath.slice('/v1/models/'.length));
          const model = listModels(store).find((m) => m.id === id);
          if (!model) {
            return send(res, 404, { error: { message: `Model "${id}" not found`, type: 'invalid_request_error', code: 'model_not_found' } });
          }
          return send(res, 200, model);
        }
        if (req.method !== 'POST') {
          return send(res, 405, { error: { message: 'Method not allowed', type: 'invalid_request_error' } });
        }

        const ctype = String(req.headers['content-type'] || '');
        const forcedProvider = url.searchParams.get('provider') || req.headers['x-bluerouter-provider'] || null;

        if (ctype.includes('multipart/form-data')) {
          const raw = await readBody(req, RAW_LIMIT);
          return await proxyRequest({
            req, res, store, openaiPath, raw, contentType: ctype, forcedProvider,
          });
        }

        const rawBuf = await readBody(req, JSON_LIMIT);
        let body;
        try {
          body = rawBuf.length ? JSON.parse(rawBuf.toString('utf8')) : {};
        } catch {
          return send(res, 400, {
            error: { message: 'Invalid JSON body', type: 'invalid_request_error', code: 'invalid_json' },
          });
        }
        return await proxyRequest({ req, res, store, openaiPath, body, forcedProvider });
      }

      /* ---------------------------- admin ----------------------------- */
      if (p.startsWith('/admin')) {
        if (tooManyFailures(ip)) {
          return send(res, 429, { error: { message: 'Too many failed attempts. Wait 5 minutes.', type: 'rate_limited' } });
        }
        const token = tokenFrom(req, url);
        const ok = store.get().adminToken === token || store.checkClientKey(token);
        if (!ok) {
          noteFailure(ip);
          return send(res, 401, {
            error: { message: 'Admin token required (blue url shows it)', type: 'unauthorized', code: 'invalid_admin_token' },
          });
        }
        return await handleAdmin({ req, res, store, p, url, startedAt });
      }

      return send(res, 404, { error: { message: `Not found: ${p}`, type: 'invalid_request_error' } });
    } catch (err) {
      console.error('[server] unhandled:', err && err.stack ? err.stack : err);
      return send(res, err.statusCode || 500, {
        error: { message: err.message || 'Internal error', type: 'server_error' },
      });
    }
  });

  server.headersTimeout = 65000;
  server.requestTimeout = 0; // long streams are fine
  server.keepAliveTimeout = 65000;

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return { server, startedAt };
}

/* ------------------------------------------------------------------ */
/* Admin API                                                           */
/* ------------------------------------------------------------------ */

async function handleAdmin({ req, res, store, p, url, startedAt }) {
  const cfg = store.get();
  const method = req.method;

  const json = async (limit = JSON_LIMIT) => {
    const buf = await readBody(req, limit);
    try {
      return buf.length ? JSON.parse(buf.toString('utf8')) : {};
    } catch {
      throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 });
    }
  };

  /* ------------------------------ keys ----------------------------- */
  if (p === '/admin/keys' && method === 'GET') {
    return send(res, 200, { data: store.publicKeys() });
  }

  if (p === '/admin/keys' && method === 'POST') {
    const body = await json();
    const { provider, key, name, priority, tpm } = body;
    try {
      const account = store.addKey({ provider, key, name, priority });
      if (tpm != null) account.tpm = Number(tpm) || 0;
      store.save();
      // kick off a health check in the background
      checkAccount(store, account).catch(() => {});
      return send(res, 201, { data: store.publicKey(account) });
    } catch (err) {
      return send(res, 400, { error: { message: err.message, type: 'invalid_request_error' } });
    }
  }

  if (p === '/admin/keys/bulk' && method === 'POST') {
    const body = await json();
    const provider = body.provider;
    const keys = Array.isArray(body.keys) ? body.keys : String(body.keys || '').split(/[\s,;]+/);
    const added = [];
    const skipped = [];
    for (const raw of keys) {
      const k = String(raw || '').trim();
      if (!k) continue;
      try {
        added.push(store.publicKey(store.addKey({ provider, key: k, name: body.name || '', quiet: true })));
      } catch (err) {
        skipped.push({ key: maskKey(k), reason: err.message });
      }
    }
    store.save();
    return send(res, 201, { data: { added, skipped } });
  }

  const keyMatch = p.match(/^\/admin\/keys\/([^/]+)(?:\/(check|enable|disable|rename))?$/);
  if (keyMatch) {
    const id = decodeURIComponent(keyMatch[1]);
    const action = keyMatch[2];
    const account = store.getKey(id);
    if (!account) return send(res, 404, { error: { message: `Account ${id} not found`, type: 'not_found' } });

    if (!action && method === 'GET') return send(res, 200, { data: store.publicKey(account) });

    if (!action && method === 'PATCH') {
      const body = await json();
      const allowed = ['name', 'enabled', 'priority', 'tpm', 'audio'];
      for (const k of allowed) {
        if (body[k] !== undefined) account[k] = body[k];
      }
      store.save();
      return send(res, 200, { data: store.publicKey(account) });
    }

    if (!action && method === 'DELETE') {
      store.removeKey(id);
      return send(res, 200, { ok: true, removed: id });
    }

    if (action === 'check' && method === 'POST') {
      const result = await checkAccount(store, account);
      return send(res, 200, { data: { ...result, account: store.publicKey(account) } });
    }
    if (action === 'enable' && method === 'POST') {
      account.enabled = true;
      account.cooldownUntil = null;
      store.save();
      return send(res, 200, { data: store.publicKey(account) });
    }
    if (action === 'disable' && method === 'POST') {
      account.enabled = false;
      store.save();
      return send(res, 200, { data: store.publicKey(account) });
    }
    if (action === 'rename' && method === 'POST') {
      const body = await json();
      if (!body.name) return send(res, 400, { error: { message: 'name is required' } });
      account.name = String(body.name).slice(0, 60);
      store.save();
      return send(res, 200, { data: store.publicKey(account) });
    }
  }

  if (p === '/admin/cooldowns/clear' && method === 'POST') {
    store.clearCooldowns();
    return send(res, 200, { ok: true });
  }

  /* ------------------------------- check all ----------------------- */
  if (p === '/admin/check-all' && method === 'POST') {
    const results = [];
    for (const account of store.keys()) {
      // sequential to stay gentle on provider APIs
      // eslint-disable-next-line no-await-in-loop
      results.push({ id: account.id, name: account.name, provider: account.provider, ...(await checkAccount(store, account)) });
    }
    return send(res, 200, { data: results });
  }

  /* ------------------------------ config --------------------------- */
  if (p === '/admin/config' && method === 'GET') {
    const c = store.publicConfig();
    return send(res, 200, {
      ...c,
      appVersion: pkg.version,
      clientKey: cfg.clientKey,
      adminToken: cfg.adminToken,
      dataDir: store.dir,
      configPath: store.configPath,
      node: process.version,
      platform: `${os.type()} ${os.release()}`,
    });
  }

  if (p === '/admin/config' && method === 'PATCH') {
    const body = await json();
    if (body.routing && typeof body.routing === 'object') {
      const allowed = ['mode', 'cooldownSeconds', 'maxRetries', 'timeoutMs', 'exposeUpstreamErrors', 'forceModel'];
      for (const k of allowed) {
        if (body.routing[k] !== undefined) cfg.routing[k] = body.routing[k];
      }
    }
    if (body.requestLog && typeof body.requestLog === 'object') {
      if (body.requestLog.enabled !== undefined) cfg.requestLog.enabled = !!body.requestLog.enabled;
      if (body.requestLog.maxEntries !== undefined) cfg.requestLog.maxEntries = Math.max(100, Math.min(20000, Number(body.requestLog.maxEntries) || 2000));
    }
    if (body.port !== undefined) {
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return send(res, 400, { error: { message: 'Invalid port' } });
      }
      cfg.port = port;
    }
    store.save();
    return send(res, 200, { data: store.publicConfig(), restartRequired: body.port !== undefined });
  }

  if (p === '/admin/rotate-client-key' && method === 'POST') {
    const { newSecret } = require('./store');
    cfg.clientKey = newSecret('blue_');
    store.save();
    return send(res, 200, { clientKey: cfg.clientKey });
  }

  /* ---------------------------- providers -------------------------- */
  if (p === '/admin/providers' && method === 'GET') {
    const rows = allProviders(cfg).map((provider) => {
      const accounts = store.keys(provider.id);
      return {
        id: provider.id,
        label: provider.label,
        enabled: provider.enabled,
        baseUrl: provider.baseUrl,
        protocol: provider.protocol,
        authStyle: provider.authStyle,
        models: provider.models,
        quota: provider.quota,
        docs: provider.docs,
        audio: provider.audio,
        canAdd: !!provider.baseUrl || provider.id === 'custom',
        accounts: accounts.length,
        active: accounts.filter((a) => a.enabled).length,
        daily: store.providerDaily(provider.id),
        health: accounts.length
          ? accounts.every((a) => (a.health || {}).status === 'ok') ? 'ok'
            : accounts.some((a) => (a.health || {}).status === 'invalid-key') ? 'invalid-key' : 'unknown'
          : 'empty',
      };
    });
    return send(res, 200, { data: rows });
  }

  const provMatch = p.match(/^\/admin\/providers\/([^/]+)$/);
  if (provMatch && method === 'PATCH') {
    const id = decodeURIComponent(provMatch[1]);
    const body = await json();
    if (body.baseUrl !== undefined && !String(body.baseUrl).trim()) {
      return send(res, 400, { error: { message: 'baseUrl cannot be empty', type: 'invalid_request_error' } });
    }
    if (!cfg.providers[id]) cfg.providers[id] = {};
    const slot = cfg.providers[id];
    for (const k of ['enabled', 'baseUrl', 'protocol', 'authStyle', 'models']) {
      if (body[k] !== undefined) slot[k] = body[k];
    }
    if (!getProvider(id, cfg)) {
      return send(res, 400, { error: { message: `Provider "${id}" needs a baseUrl` } });
    }
    store.save();
    return send(res, 200, { data: getProvider(id, cfg) });
  }

  /* ------------------------------ models --------------------------- */
  if (p === '/admin/models' && method === 'GET') {
    // Aggregate live model lists from every provider that has an account.
    const fresh = url.searchParams.get('fresh') === '1';
    const results = [];
    const seenAccounts = new Set();
    for (const account of store.keys()) {
      if (!account.enabled) continue;
      const provider = getProvider(account.provider, cfg);
      if (!provider) continue;
      if (seenAccounts.has(provider.id)) continue;
      seenAccounts.add(provider.id);
      let models = provider.models || [];
      let live = false;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), fresh ? 8000 : 3000);
        const r = await fetch(upstreamUrl(provider, '/v1/models'), {
          headers: buildHeaders(provider, account.key, null, {}),
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (r.ok) {
          const data = await r.json();
          if (Array.isArray(data.data)) {
            models = data.data.map((m) => m.id).filter(Boolean).slice(0, 300);
            live = true;
          }
        }
      } catch { /* fall back to configured list */ }
      results.push({ provider: provider.id, label: provider.label, models, live });
    }
    return send(res, 200, { data: results });
  }

  /* ------------------------------- test ---------------------------- */
  if (p === '/admin/test' && method === 'POST') {
    const body = await json();
    let model = body.model || cfg.routing.forceModel || '';
    if (!model) {
      const first = store.keys().find((k) => k.enabled);
      const provider = first && getProvider(first.provider, cfg);
      model = (provider && provider.models && provider.models[0]) || 'llama-3.3-70b-versatile';
    }
    const messages = [
      { role: 'system', content: 'You are a connectivity test. Reply in one short sentence.' },
      { role: 'user', content: body.prompt || 'Say "BlueRouter is live" and nothing else.' },
    ];
    const chunks = [];
    const fakeReq = { headers: { 'content-type': 'application/json' }, on() {} };
    const fakeRes = {
      statusCode: 200,
      headersSent: false,
      writableEnded: false,
      headers: {},
      writeHead(code, headers) {
        this.statusCode = code;
        this.headersSent = true;
        Object.assign(this.headers, headers || {});
        return this;
      },
      write() { return true; },
      end(buf) {
        if (buf) chunks.push(Buffer.from(buf));
        this.writableEnded = true;
      },
      on() { return this; },
      destroy() { this.writableEnded = true; },
      flushHeaders() {},
    };
    const started = Date.now();
    await proxyRequest({
      req: fakeReq,
      res: fakeRes,
      store,
      openaiPath: '/v1/chat/completions',
      body: { model, messages, max_tokens: body.max_tokens || 64, temperature: 0.2, stream: false },
      forcedProvider: body.provider || null,
    });
    const text = Buffer.concat(chunks).toString('utf8');
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch { /* ignore */ }
    const message = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message
      ? parsed.choices[0].message.content
      : null;
    return send(res, 200, {
      data: {
        ok: fakeRes.statusCode === 200 && !!message,
        status: fakeRes.statusCode,
        ms: Date.now() - started,
        provider: fakeRes.headers['x-bluerouter-provider'] || null,
        account: fakeRes.headers['x-bluerouter-account'] || null,
        model: parsed ? parsed.model : model,
        reply: message,
        error: parsed && parsed.error ? parsed.error.message : null,
        usage: parsed ? parsed.usage : null,
      },
    });
  }

  /* ------------------------------ stats ---------------------------- */
  if (p === '/admin/stats' && method === 'GET') {
    const keys = store.keys();
    const totals = {
      requests: 0, success: 0, fail: 0, tokensIn: 0, tokensOut: 0,
      accounts: keys.length, activeAccounts: keys.filter((k) => k.enabled).length,
      cooling: keys.filter((k) => k.cooldownUntil && Date.parse(k.cooldownUntil) > Date.now()).length,
      providers: new Set(keys.map((k) => k.provider)).size,
      latencySamples: 0, latencyTotal: 0,
    };
    const byProvider = {};
    for (const k of keys) {
      const s = k.stats || {};
      totals.requests += s.requests || 0;
      totals.success += s.success || 0;
      totals.fail += s.fail || 0;
      totals.tokensIn += s.tokensIn || 0;
      totals.tokensOut += s.tokensOut || 0;
      if (s.lastLatencyMs) {
        totals.latencySamples += 1;
        totals.latencyTotal += s.lastLatencyMs;
      }
      if (!byProvider[k.provider]) {
        byProvider[k.provider] = {
          id: k.provider,
          label: (getProvider(k.provider, cfg) || {}).label || k.provider,
          accounts: 0, active: 0, requests: 0, fail: 0, tokensIn: 0, tokensOut: 0,
        };
      }
      const row = byProvider[k.provider];
      row.accounts += 1;
      if (k.enabled) row.active += 1;
      row.requests += s.requests || 0;
      row.fail += s.fail || 0;
      row.tokensIn += s.tokensIn || 0;
      row.tokensOut += s.tokensOut || 0;
    }
    const logs = store.readLogs(300);
    const okLogs = logs.filter((l) => l.ok);
    const recentLatency = okLogs.length
      ? Math.round(okLogs.reduce((a, l) => a + (l.ms || 0), 0) / okLogs.length)
      : null;
    const lastHour = logs.filter((l) => Date.now() - Date.parse(l.ts) < 3600e3);
    return send(res, 200, {
      data: {
        uptimeMs: Date.now() - startedAt,
        startedAt: iso(startedAt),
        version: pkg.version,
        node: process.version,
        host: os.hostname(),
        totals: {
          ...totals,
          avgLatencyMs: totals.latencySamples ? Math.round(totals.latencyTotal / totals.latencySamples) : null,
        },
        minute: store.minute,
        lastHour: {
          requests: lastHour.length,
          fail: lastHour.filter((l) => !l.ok).length,
          tokens: lastHour.reduce((a, l) => a + (l.tokensIn || 0) + (l.tokensOut || 0), 0),
        },
        recentLatencyMs: recentLatency,
        providers: Object.values(byProvider),
        memory: {
          rss: process.memoryUsage().rss,
          heapUsed: process.memoryUsage().heapUsed,
        },
        routing: cfg.routing,
      },
    });
  }

  /* ------------------------------- logs ---------------------------- */
  if (p === '/admin/logs' && method === 'GET') {
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    const provider = url.searchParams.get('provider');
    const onlyErrors = url.searchParams.get('errors') === '1';
    let logs = store.readLogs(limit * 3);
    if (provider) logs = logs.filter((l) => l.provider === provider);
    if (onlyErrors) logs = logs.filter((l) => !l.ok);
    return send(res, 200, { data: logs.slice(0, limit) });
  }

  if (p === '/admin/logs' && method === 'DELETE') {
    store.clearLogs();
    return send(res, 200, { ok: true });
  }

  /* ---------------------------- backup ----------------------------- */
  if (p === '/admin/export' && method === 'GET') {
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="bluerouter-config-${new Date().toISOString().slice(0, 10)}.json"`,
      'cache-control': 'no-store',
    });
    return res.end(JSON.stringify(cfg, null, 2));
  }

  if (p === '/admin/import' && method === 'POST') {
    const body = await json();
    const incoming = body.config || body;
    if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.keys)) {
      return send(res, 400, { error: { message: 'Invalid config export (missing keys array)' } });
    }
    const { newSecret } = require('./store');
    const merged = { ...store.get(), ...incoming };
    merged.keys = incoming.keys;
    if (!merged.clientKey) merged.clientKey = newSecret('blue_');
    if (!merged.adminToken) merged.adminToken = newSecret('blueadmin_');
    if (!merged.instanceId) merged.instanceId = require('crypto').randomBytes(8).toString('hex');
    store.config = merged;
    store._normalizeKeys();
    store._touchRuntime();
    store.save();
    return send(res, 200, { ok: true, accounts: store.keys().length, clientKey: merged.clientKey });
  }

  /* --------------------------- dashboard url ----------------------- */
  if (p === '/admin/urls' && method === 'GET') {
    const port = cfg.port;
    const forwardedHost = req.headers['x-forwarded-host'] || req.headers['x-forwarded-server'];
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const publicBase = forwardedHost
      ? `${forwardedProto || 'https'}://${String(forwardedHost).split(',')[0].trim()}`
      : null;
    const base = publicBase || `http://${lanIp()}:${port}`;
    return send(res, 200, {
      data: {
        local: `http://127.0.0.1:${port}`,
        lan: `http://${lanIp()}:${port}`,
        public: publicBase,
        apiBase: `${base}/v1`,
        dashboard: `${base}/#token=${cfg.adminToken}`,
        health: `${base}/health`,
      },
    });
  }

  return send(res, 404, { error: { message: `Unknown admin route ${p}`, type: 'not_found' } });
}

function serveFile(res, file) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      return send(res, 404, { error: { message: 'Not found' } });
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    fs.createReadStream(file).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */

function start({ port, host, dataDir, quiet = false } = {}) {
  const store = new Store({ dataDir }).init();
  const cfg = store.get();
  const listenPort = port || Number(process.env.PORT) || cfg.port || 1212;
  const listenHost = host || cfg.host || '0.0.0.0';

  const { server, startedAt } = createServer(store);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, () => {
      cfg.port = listenPort;
      store.save();
      const banner = [
        '',
        '  ██████╗ ██╗     ██╗   ██╗███████╗',
        '  ██╔══██╗██║     ██║   ██║██╔════╝',
        '  ██████╔╝██║     ██║   ██║█████╗  ',
        '  ██╔══██╗██║     ██║   ██║██╔══╝  ',
        '  ██████╔╝███████╗╚██████╔╝███████╗',
        '  ╚═════╝ ╚══════╝ ╚═════╝ ╚══════╝  v' + pkg.version,
        '',
        '  One API for all your AI accounts',
        '',
        `  Dashboard : http://${lanIp()}:${listenPort}`,
        `  API base  : http://${lanIp()}:${listenPort}/v1`,
        `  Health    : http://${lanIp()}:${listenPort}/health`,
        `  Accounts  : ${store.keys().length}   Providers: ${new Set(store.keys().map((k) => k.provider)).size}`,
        '',
      ].join('\n');
      if (!quiet) console.log(banner);
      resolve({ server, store, port: listenPort, host: listenHost, startedAt });
    });
  });
}

function shutdown(instance, signal = 'SIGTERM') {
  if (!instance || !instance.server) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        instance.store.flush();
      } catch { /* ignore */ }
      resolve();
    };
    try {
      instance.server.close(finish);
      try { instance.server.closeIdleConnections(); } catch { /* older node */ }
      setTimeout(() => {
        try { instance.server.closeAllConnections(); } catch { /* node <18.2 */ }
        finish();
      }, 3000).unref();
    } catch {
      finish();
    }
    console.log(`[bluerouter] ${signal} received, shutting down…`);
  });
}

module.exports = { createServer, start, shutdown, checkAccount, readBody, serveFile };

/* ------------------------------------------------------------------ */
/* CLI entry point: `node src/server.js` (used by systemd)             */
/* ------------------------------------------------------------------ */

if (require.main === module) {
  start()
    .then((instance) => {
      const stop = (sig) => shutdown(instance, sig).then(() => process.exit(0));
      process.on('SIGINT', () => stop('SIGINT'));
      process.on('SIGTERM', () => stop('SIGTERM'));
      process.on('uncaughtException', (err) => {
        console.error('[bluerouter] uncaught exception:', err && err.stack ? err.stack : err);
      });
      process.on('unhandledRejection', (err) => {
        console.error('[bluerouter] unhandled rejection:', err && err.stack ? err.stack : err);
      });
    })
    .catch((err) => {
      console.error(`[bluerouter] failed to start: ${err.message}`);
      process.exit(1);
    });
}
