'use strict';

/**
 * Store — everything that lives on disk.
 *
 *   data/config.json   settings + account registry (chmod 600, never public)
 *   data/requests.log  JSONL request log (rotated)
 *   data/backups/      rolling config backups
 *
 * Account keys are stored in config.json under `keys` (array) and are always
 * masked before leaving the process.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { iso, shortId, maskKey, safeJsonParse, promptText } = require('./util');
const { getProvider, DEFAULT_PROVIDERS } = require('./providers');

const DAY = 24 * 60 * 60 * 1000;

function newSecret(prefix) {
  return `${prefix}${crypto.randomBytes(24).toString('base64url')}`;
}

function defaultConfig() {
  const providers = {};
  for (const [id, p] of Object.entries(DEFAULT_PROVIDERS)) {
    providers[id] = {
      enabled: p.enabled !== false,
      baseUrl: p.baseUrl,
      protocol: p.protocol || 'openai',
      authStyle: p.authStyle || 'bearer',
      quota: { ...p.quota },
      models: p.models.slice(),
    };
  }
  return {
    version: 1,
    createdAt: iso(),
    instanceId: crypto.randomBytes(8).toString('hex'),
    port: 1212,
    host: '0.0.0.0',
    clientKey: newSecret('blue_'),
    adminToken: newSecret('blueadmin_'),
    providers,
    routing: {
      mode: 'random', // random = spread across accounts, sticky = reuse a warm one
      cooldownSeconds: 300,
      maxRetries: 3,
      timeoutMs: 180000,
      exposeUpstreamErrors: true,
      forceModel: '',
    },
    requestLog: { enabled: true, maxEntries: 2000 },
    keys: [],
  };
}

/** Deep-merge so configs created by older versions always boot. */
function mergeDefaults(target, defaults) {
  const out = { ...defaults, ...target };
  for (const [k, v] of Object.entries(defaults)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = mergeDefaults(target && typeof target[k] === 'object' && !Array.isArray(target[k]) ? target[k] : {}, v);
    }
  }
  return out;
}

class Store {
  constructor(opts = {}) {
    this.dir = opts.dataDir || process.env.BLUEROUTER_DATA || path.join(__dirname, '..', 'data');
    this.configPath = path.join(this.dir, 'config.json');
    this.logPath = path.join(this.dir, 'requests.log');
    this.backupDir = path.join(this.dir, 'backups');
    this.config = null;
    this.runtime = new Map(); // per-key non-persistent state
    this.daily = {}; // per-provider counters
    this.minute = { window: 0, count: 0, tokens: 0 };
    this._lastBackup = 0;
    this._saveTimer = null;
    this._logQueue = [];
    this._flushing = false;
    this._logCount = 0;
    this.startedAt = Date.now();
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  init() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.configPath)) {
      const raw = fs.readFileSync(this.configPath, 'utf8');
      const parsed = safeJsonParse(raw);
      if (!parsed) throw new Error(`config.json is corrupt: ${this.configPath}`);
      this.config = mergeDefaults(parsed, defaultConfig());
      if (!Array.isArray(this.config.keys)) this.config.keys = [];
    } else {
      this.config = defaultConfig();
    }
    if (!this.config.port) this.config.port = 1212;
    this._migrateLegacyKeys();
    this._normalizeKeys();
    this._touchRuntime();
    this._countLogLines();
    this.save();
    return this;
  }

  /** Older builds kept keys inside providers.<id>.keys — fold them in. */
  _migrateLegacyKeys() {
    for (const [provider, p] of Object.entries(this.config.providers || {})) {
      if (Array.isArray(p.keys) && p.keys.length) {
        for (const k of p.keys) {
          if (!k) continue;
          const raw = typeof k === 'string' ? k : k.key;
          if (raw) this.addKey({ provider, key: raw, name: (k && k.name) || '', quiet: true });
        }
        delete p.keys;
      }
    }
  }

  /** Make hand-edited / imported configs safe to use. */
  _normalizeKeys() {
    const label = (id) => (getProvider(id, this.config) || {}).label || id;
    this.config.keys = (this.config.keys || []).map((k, i) => {
      const key = k && typeof k === 'object' ? k : { key: String(k || '') };
      key.id = key.id || `acc_imported_${i}`;
      key.provider = key.provider || 'custom';
      key.name = key.name || `${label(key.provider)} #${i + 1}`;
      key.enabled = key.enabled !== false;
      key.priority = Number(key.priority) || 0;
      key.audio = key.audio !== false;
      key.createdAt = key.createdAt || iso();
      key.lastUsedAt = key.lastUsedAt || null;
      key.lastErrorAt = key.lastErrorAt || null;
      key.lastError = key.lastError || null;
      key.cooldownUntil = key.cooldownUntil || null;
      key.health = key.health || { status: 'unknown', latencyMs: null, checkedAt: null, detail: 'Not checked yet' };
      key.stats = key.stats || {};
      const s = key.stats;
      for (const f of ['requests', 'success', 'fail', 'retries', 'streamed', 'tokensIn', 'tokensOut', 'bytesIn', 'bytesOut', 'totalLatencyMs', 'latencySamples']) {
        s[f] = Number(s[f]) || 0;
      }
      s.lastLatencyMs = s.lastLatencyMs || null;
      key.daily = key.daily || { date: today(), requests: 0, success: 0, fail: 0, tokensIn: 0, tokensOut: 0 };
      return key;
    });
  }

  _touchRuntime() {
    for (const key of this.config.keys) {
      if (!this.runtime.has(key.id)) {
        this.runtime.set(key.id, { inflight: 0, minuteWindow: 0, minuteCount: 0, minuteTokens: 0 });
      }
    }
    for (const id of [...this.runtime.keys()]) {
      if (!this.config.keys.find((k) => k.id === id)) this.runtime.delete(id);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Read / write                                                      */
  /* ---------------------------------------------------------------- */

  get() {
    return this.config;
  }

  getPath(p) {
    return p.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), this.config);
  }

  setPath(p, value) {
    const parts = p.split('.');
    let node = this.config;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (node[parts[i]] == null || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
    this.save();
    return this.config;
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.configPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.config, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.configPath);
    try {
      fs.chmodSync(this.configPath, 0o600);
    } catch { /* best effort (e.g. FAT32) */ }
    this._backupIfDue();
  }

  /** Debounced save — used for high-frequency stat updates. */
  saveSoon(delay = 1500) {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        this.save();
      } catch (err) {
        console.error('[store] save failed:', err.message);
      }
    }, delay);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this.save();
    this._flushLogs();
  }

  _backupIfDue() {
    const now = Date.now();
    if (now - this._lastBackup < 5 * 60 * 1000) return;
    this._lastBackup = now;
    try {
      const name = `config-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`;
      fs.writeFileSync(path.join(this.backupDir, name), JSON.stringify(this.config, null, 2), { mode: 0o600 });
      const files = fs.readdirSync(this.backupDir).filter((f) => f.startsWith('config-')).sort();
      for (const old of files.slice(0, Math.max(0, files.length - 10))) {
        fs.unlinkSync(path.join(this.backupDir, old));
      }
    } catch { /* backups are best effort */ }
  }

  /* ---------------------------------------------------------------- */
  /* Accounts / keys                                                   */
  /* ---------------------------------------------------------------- */

  keys(provider) {
    const list = this.config.keys || [];
    return provider ? list.filter((k) => k.provider === provider) : list;
  }

  getKey(id) {
    return (this.config.keys || []).find((k) => k.id === id) || null;
  }

  addKey({ provider, key, name = '', priority = 0, quiet = false }) {
    const p = getProvider(provider, this.config);
    if (!p) throw new Error(`Unknown provider "${provider}". Run: blue providers`);
    const trimmed = String(key || '').trim();
    if (!trimmed) throw new Error('API key is empty');
    const existing = this.keys(provider).find((k) => k.key === trimmed);
    if (existing) {
      if (!quiet) throw new Error(`This ${p.label} key is already added (account ${existing.id}).`);
      return existing;
    }
    const account = {
      id: shortId('acc'),
      provider,
      key: trimmed,
      name: name || `${p.label} #${this.keys(provider).length + 1}`,
      enabled: true,
      priority: Number(priority) || 0,
      audio: true,
      createdAt: iso(),
      lastUsedAt: null,
      lastErrorAt: null,
      lastError: null,
      cooldownUntil: null,
      health: { status: 'unknown', latencyMs: null, checkedAt: null, detail: 'Not checked yet' },
      stats: {
        requests: 0,
        success: 0,
        fail: 0,
        retries: 0,
        streamed: 0,
        tokensIn: 0,
        tokensOut: 0,
        bytesIn: 0,
        bytesOut: 0,
        lastLatencyMs: null,
        totalLatencyMs: 0,
        latencySamples: 0,
      },
      daily: { date: today(), requests: 0, success: 0, fail: 0, tokensIn: 0, tokensOut: 0 },
    };
    this.config.keys.push(account);
    this.runtime.set(account.id, { inflight: 0, minuteWindow: 0, minuteCount: 0, minuteTokens: 0 });
    if (!quiet) this.save();
    return account;
  }

  removeKey(idOrAccount) {
    const needle = String(idOrAccount || '');
    const idx = (this.config.keys || []).findIndex(
      (k) => k.id === needle || k.id === `acc_${needle}` || maskKey(k.key) === needle,
    );
    if (idx === -1) throw new Error(`Account "${needle}" not found. Run: blue keys`);
    const [removed] = this.config.keys.splice(idx, 1);
    this.runtime.delete(removed.id);
    this.save();
    return removed;
  }

  updateKey(id, patch) {
    const key = this.getKey(id);
    if (!key) throw new Error(`Account "${id}" not found`);
    Object.assign(key, patch);
    this.save();
    return key;
  }

  renameKey(id, name) {
    const key = this.getKey(id);
    if (!key) throw new Error(`Account "${id}" not found`);
    key.name = name;
    this.save();
    return key;
  }

  clearCooldowns() {
    for (const k of this.keys()) {
      k.cooldownUntil = null;
      k.lastError = null;
      k.health = { status: 'unknown', latencyMs: null, checkedAt: null, detail: 'Cooldown cleared' };
    }
    this.save();
  }

  rt(key) {
    return this.runtime.get(key.id) || { inflight: 0, minuteWindow: 0, minuteCount: 0, minuteTokens: 0 };
  }

  /* ---------------------------------------------------------------- */
  /* Routing                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Pick the best account for a request.
   * Filters by provider, enabled, cooldown (model-aware), audio capability and
   * per-minute limits, then orders by fewest in-flight requests + LRU.
   */
  pickKey({ provider, model, body, requireAudio = false, exclude = [] }) {
    const now = Date.now();
    const candidates = this.keys(provider).filter((k) => !exclude.includes(k.id));
    const usable = [];
    const rejected = { disabled: 0, cooldown: 0, audio: 0, rate: 0 };
    const estimate = Math.ceil(promptText(body).length / 4) + Number((body && body.max_tokens) || 0);

    for (const key of candidates) {
      if (!key.enabled) {
        rejected.disabled += 1;
        continue;
      }
      if (key.cooldownUntil && new Date(key.cooldownUntil).getTime() > now) {
        const scope = key.cooldownScope || 'all';
        const applies = scope === 'all' || !key.cooldownModel || key.cooldownModel === model;
        if (applies) {
          rejected.cooldown += 1;
          continue;
        }
      }
      if (requireAudio && key.audio === false) {
        rejected.audio += 1;
        continue;
      }
      const rt = this.rt(key);
      if (rt.minuteWindow !== Math.floor(now / 60000)) {
        rt.minuteWindow = Math.floor(now / 60000);
        rt.minuteCount = 0;
        rt.minuteTokens = 0;
      }
      const tpm = Number(key.tpm) || 0;
      if (tpm > 0 && rt.minuteCount > 0 && rt.minuteTokens + estimate > tpm) {
        rejected.rate += 1;
        continue;
      }
      usable.push(key);
    }

    if (!usable.length) {
      return { key: null, list: [], rejected, total: candidates.length };
    }

    usable.sort((a, b) => {
      const ra = this.rt(a);
      const rb = this.rt(b);
      if (ra.inflight !== rb.inflight) return ra.inflight - rb.inflight;
      const pa = Number(a.priority) || 0;
      const pb = Number(b.priority) || 0;
      if (pa !== pb) return pb - pa;
      const ta = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0;
      const tb = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0;
      return ta - tb;
    });

    if (this.config.routing.mode === 'random' && usable.length > 1) {
      return { key: usable[Math.floor(Math.random() * usable.length)], list: usable, rejected, total: candidates.length };
    }
    return { key: usable[0], list: usable, rejected, total: candidates.length };
  }

  acquire(key) {
    const rt = this.rt(key);
    rt.inflight += 1;
    const win = Math.floor(Date.now() / 60000);
    if (rt.minuteWindow !== win) {
      rt.minuteWindow = win;
      rt.minuteCount = 0;
      rt.minuteTokens = 0;
    }
    rt.minuteCount += 1;
    this.runtime.set(key.id, rt);
    return rt;
  }

  release(key, tokensUsed = 0) {
    const rt = this.rt(key);
    rt.inflight = Math.max(0, rt.inflight - 1);
    rt.minuteTokens += Number(tokensUsed) || 0;
    this.runtime.set(key.id, rt);
  }

  recordSuccess(key, { latencyMs = 0, tokensIn = 0, tokensOut = 0, bytesIn = 0, bytesOut = 0, streamed = false } = {}) {
    this._rollDaily(key);
    key.lastUsedAt = iso();
    key.lastError = null;
    key.lastErrorAt = null;
    key.cooldownUntil = null;
    key.cooldownScope = null;
    key.health = {
      status: 'ok',
      latencyMs: Math.round(latencyMs) || null,
      checkedAt: iso(),
      detail: 'Working',
    };
    const s = key.stats;
    s.requests += 1;
    s.success += 1;
    s.tokensIn += tokensIn;
    s.tokensOut += tokensOut;
    s.bytesIn += bytesIn;
    s.bytesOut += bytesOut;
    if (streamed) s.streamed += 1;
    s.lastLatencyMs = Math.round(latencyMs) || null;
    s.totalLatencyMs += Math.round(latencyMs) || 0;
    s.latencySamples += 1;
    key.daily.requests += 1;
    key.daily.success += 1;
    key.daily.tokensIn += tokensIn;
    key.daily.tokensOut += tokensOut;
    this._bumpDaily(key.provider, 'requests', 1);
    this._bumpDaily(key.provider, 'success', 1);
    this._bumpDaily(key.provider, 'tokensIn', tokensIn);
    this._bumpDaily(key.provider, 'tokensOut', tokensOut);
    this._bumpMinute(tokensIn + tokensOut, 1);
    this.saveSoon();
  }

  recordFailure(key, { status = 0, message = '', latencyMs = 0, cooldownMs = 0, scope = 'all', model = null, counted = true, soft = false } = {}) {
    const now = Date.now();
    this._rollDaily(key);
    const s = key.stats;
    if (counted) {
      if (key.lastError) s.retries += 1;
      s.requests += 1;
      s.fail += 1;
      key.daily.requests += 1;
      key.daily.fail += 1;
      this._bumpDaily(key.provider, 'requests', 1);
      this._bumpDaily(key.provider, 'fail', 1);
      this._bumpMinute(0, 1);
    }
    if (soft) {
      // The account is fine — the provider just doesn't serve this model/route.
      this.saveSoon();
      return;
    }
    key.lastErrorAt = iso();
    key.lastError = `${status ? `HTTP ${status}: ` : ''}${message || 'Request failed'}`.slice(0, 300);
    if (cooldownMs > 0) {
      key.cooldownUntil = new Date(now + cooldownMs).toISOString();
      key.cooldownScope = scope;
      key.cooldownModel = scope === 'model' ? model : null;
      key.health = {
        status: healthStatusFor(status, latencyMs),
        latencyMs: Math.round(latencyMs) || null,
        checkedAt: iso(),
        detail: key.lastError,
      };
    } else {
      key.health = {
        status: healthStatusFor(status, latencyMs),
        latencyMs: Math.round(latencyMs) || null,
        checkedAt: iso(),
        detail: key.lastError,
      };
    }
    this.saveSoon();
  }

  markRetry(key) {
    key.stats.retries += 1;
    this.saveSoon();
  }

  setHealth(key, { status, latencyMs = null, detail = '' }) {
    key.health = { status, latencyMs, checkedAt: iso(), detail };
    this.saveSoon();
  }

  _rollDaily(key) {
    const d = today();
    if (!key.daily || key.daily.date !== d) {
      key.daily = { date: d, requests: 0, success: 0, fail: 0, tokensIn: 0, tokensOut: 0 };
    }
  }

  _bumpDaily(provider, field, by) {
    const d = today();
    if (!this.daily[provider] || this.daily[provider].date !== d) {
      this.daily[provider] = { date: d, requests: 0, success: 0, fail: 0, tokensIn: 0, tokensOut: 0 };
    }
    this.daily[provider][field] = (this.daily[provider][field] || 0) + (Number(by) || 0);
  }

  _bumpMinute(tokens, requests) {
    const win = Math.floor(Date.now() / 60000);
    if (this.minute.window !== win) this.minute = { window: win, count: 0, tokens: 0 };
    this.minute.count += requests;
    this.minute.tokens += tokens;
  }

  providerDaily(provider) {
    const d = today();
    if (!this.daily[provider] || this.daily[provider].date !== d) {
      return { date: d, requests: 0, success: 0, fail: 0, tokensIn: 0, tokensOut: 0 };
    }
    return this.daily[provider];
  }

  /* ---------------------------------------------------------------- */
  /* Request log                                                       */
  /* ---------------------------------------------------------------- */

  writeLog(entry) {
    if (!this.config.requestLog.enabled) return;
    const line = `${JSON.stringify(entry)}\n`;
    this._logQueue.push(line);
    this._logCount += 1;
    if (this.config.requestLog.maxEntries && this._logCount > this.config.requestLog.maxEntries * 2) {
      this._rotateLogs();
    }
    this._flushLogs();
  }

  _flushLogs() {
    if (this._flushing || !this._logQueue.length) return;
    this._flushing = true;
    const chunk = this._logQueue.join('');
    this._logQueue = [];
    fs.appendFile(this.logPath, chunk, { mode: 0o600 }, (err) => {
      this._flushing = false;
      if (err) console.error('[store] log write failed:', err.message);
      else if (this._logQueue.length) this._flushLogs();
    });
  }

  _countLogLines() {
    try {
      const stat = fs.statSync(this.logPath);
      this._logCount = Math.round(stat.size / 400); // rough, rotation only
    } catch {
      this._logCount = 0;
    }
  }

  _rotateLogs() {
    try {
      if (fs.existsSync(this.logPath)) fs.renameSync(this.logPath, `${this.logPath}.1`);
      this._logCount = 0;
    } catch { /* ignore */ }
  }

  readLogs(limit = 100) {
    try {
      if (!fs.existsSync(this.logPath)) return [];
      const raw = fs.readFileSync(this.logPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const out = [];
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
        const parsed = safeJsonParse(lines[i]);
        if (parsed) out.push(parsed);
      }
      return out;
    } catch {
      return [];
    }
  }

  clearLogs() {
    this._logQueue = [];
    try {
      fs.writeFileSync(this.logPath, '', { mode: 0o600 });
    } catch { /* ignore */ }
    this._logCount = 0;
  }

  /* ---------------------------------------------------------------- */
  /* Public views                                                      */
  /* ---------------------------------------------------------------- */

  publicKey(key) {
    const rt = this.rt(key);
    const cooldownMs = key.cooldownUntil
      ? Math.max(0, new Date(key.cooldownUntil).getTime() - Date.now())
      : 0;
    const avg = key.stats.latencySamples ? Math.round(key.stats.totalLatencyMs / key.stats.latencySamples) : null;
    return {
      id: key.id,
      provider: key.provider,
      providerLabel: (getProvider(key.provider, this.config) || {}).label || key.provider,
      name: key.name,
      masked: maskKey(key.key),
      enabled: key.enabled,
      priority: key.priority || 0,
      tpm: key.tpm || 0,
      audio: key.audio !== false,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
      lastErrorAt: key.lastErrorAt,
      lastError: key.lastError,
      cooldownUntil: cooldownMs > 0 ? key.cooldownUntil : null,
      cooldownMs,
      cooldownScope: key.cooldownScope || null,
      cooldownModel: key.cooldownModel || null,
      health: key.health || { status: 'unknown' },
      avgLatencyMs: avg,
      inflight: rt.inflight,
      stats: key.stats,
      daily: key.daily || null,
    };
  }

  publicKeys() {
    return this.keys().map((k) => this.publicKey(k));
  }

  publicConfig() {
    const c = this.config;
    const providers = {};
    for (const [id, p] of Object.entries(c.providers)) {
      providers[id] = {
        enabled: p.enabled !== false,
        baseUrl: p.baseUrl,
        protocol: p.protocol || 'openai',
        quota: p.quota,
        models: p.models,
        label: (getProvider(id, c) || {}).label || id,
      };
    }
    return {
      port: c.port,
      host: c.host,
      providers,
      routing: c.routing,
      requestLog: c.requestLog,
      createdAt: c.createdAt,
      version: c.version,
    };
  }

  checkClientKey(token) {
    const expected = String(this.config.clientKey || '');
    const got = String(token || '');
    if (!expected || !got) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(got);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
}

function healthStatusFor(status) {
  if (status === 401 || status === 403) return 'invalid-key';
  if (status === 429) return 'rate-limited';
  return 'error';
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = { Store, defaultConfig, newSecret, DAY };
