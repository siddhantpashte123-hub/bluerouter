'use strict';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ICONS = {
  grid: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M11 12 20 3M16.5 6.5 19 9M14 9l2 2"/>',
  cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.2 9.2 4.5 4.5 0 0 0 7 19z"/>',
  play: '<path d="M7 4.5v15l13-7.5z"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.36a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.64 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.64h.08A1.7 1.7 0 0 0 10.1 3.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.36 9v.08a1.7 1.7 0 0 0 1.54 1.02H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  power: '<path d="M12 3v9M6.6 6.6a8 8 0 1 0 10.8 0"/>',
  pencil: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
};

const nf = new Intl.NumberFormat('en-US');

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function humanNumber(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return nf.format(Math.round(v));
}

function humanDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function ago(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  if (ms < 5000) return 'just now';
  if (ms < 60000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h ago`;
  return `${Math.round(ms / 86400000)}d ago`;
}

function clock(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderIcons(root = document) {
  $$('[data-icon]', root).forEach((node) => {
    const name = node.getAttribute('data-icon');
    if (ICONS[name]) node.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  });
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    el.style.transition = 'all .2s';
    setTimeout(() => el.remove(), 220);
  }, 3400);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Copied to clipboard', 'ok');
  } catch {
    toast('Could not copy — select it manually', 'bad');
  }
}

/* ------------------------------------------------------------------ */
/* modal                                                               */
/* ------------------------------------------------------------------ */

let modalCloseHandler = null;

function closeModal() {
  $('#modal-root').hidden = true;
  document.removeEventListener('keydown', modalCloseHandler);
  modalCloseHandler = null;
}

function openModal({ title, bodyHtml = '', actions = [] }) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  const wrap = $('#modal-actions');
  wrap.innerHTML = '';
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.className = `btn ${action.kind || ''}`;
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      if (action.onClick) action.onClick();
    });
    wrap.appendChild(btn);
  }
  $('#modal-root').hidden = false;
  modalCloseHandler = (e) => { if (e.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', modalCloseHandler);
  const first = wrap.querySelector('.btn');
  if (first) first.focus();
}

function confirmDialog(title, message, confirmLabel = 'Confirm', danger = true) {
  return new Promise((resolve) => {
    openModal({
      title,
      bodyHtml: `<p>${message}</p>`,
      actions: [
        { label: 'Cancel', kind: 'ghost', onClick: () => { closeModal(); resolve(false); } },
        {
          label: confirmLabel,
          kind: danger ? 'danger' : 'primary',
          onClick: () => { closeModal(); resolve(true); },
        },
      ],
    });
  });
}

function promptDialog(title, { label = 'Value', value = '', hint = '' } = {}) {
  return new Promise((resolve) => {
    openModal({
      title,
      bodyHtml: `<label class="field"><span>${esc(label)}</span><input id="modal-input" value="${esc(value)}" spellcheck="false"></label>${hint ? `<p class="muted">${hint}</p>` : ''}`,
      actions: [
        { label: 'Cancel', kind: 'ghost', onClick: () => { closeModal(); resolve(null); } },
        {
          label: 'Save',
          kind: 'primary',
          onClick: () => {
            const v = $('#modal-input').value.trim();
            closeModal();
            resolve(v);
          },
        },
      ],
    });
    setTimeout(() => {
      const input = $('#modal-input');
      if (input) { input.focus(); input.select(); }
    }, 30);
  });
}

function revealDialog(title, value, note = '') {
  openModal({
    title,
    bodyHtml: `<p>${note}</p><code id="modal-secret">${esc(value)}</code>`,
    actions: [
      { label: 'Copy', kind: 'ghost', onClick: () => copyText(value) },
      { label: 'Done', kind: 'primary', onClick: closeModal },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* state + api                                                         */
/* ------------------------------------------------------------------ */

const state = {
  token: '',
  config: null,
  stats: null,
  keys: [],
  providers: [],
  logs: [],
  models: [],
  modelsLoaded: false,
  tab: 'overview',
  filter: { provider: '', q: '' },
  logFilter: { provider: '', errors: false, limit: 100 },
  chat: [],
  busy: false,
  refreshing: false,
};

async function admin(path, opts = {}) {
  const res = await fetch(`/admin${path}`, {
    method: opts.method || 'GET',
    headers: {
      authorization: `Bearer ${state.token}`,
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) {
    logout(true);
    throw new Error('Session expired — sign in again');
  }
  if (!res.ok) {
    const msg = json && json.error ? (json.error.message || json.error.type) : `HTTP ${res.status}`;
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return json;
}

function endpointBase() {
  return `${location.origin}/v1`;
}

async function loadConfig() {
  state.config = await admin('/config');
  return state.config;
}

async function loadStats() {
  state.stats = (await admin('/stats')).data;
}

async function loadKeys() {
  state.keys = (await admin('/keys')).data;
}

async function loadProviders() {
  state.providers = (await admin('/providers')).data;
}

async function loadLogs() {
  const q = new URLSearchParams({ limit: String(state.logFilter.limit) });
  if (state.logFilter.provider) q.set('provider', state.logFilter.provider);
  if (state.logFilter.errors) q.set('errors', '1');
  state.logs = (await admin(`/logs?${q}`)).data;
}

async function loadModels(fresh = false) {
  const data = (await admin(`/models${fresh ? '?fresh=1' : ''}`)).data;
  state.models = data;
  state.modelsLoaded = true;
}

async function refreshCore({ silent = true } = {}) {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    await Promise.all([loadStats(), loadKeys()]);
    if (!state.providers.length) await loadProviders();
    renderSidebar();
    if (state.tab === 'overview') { await loadLogs().catch(() => {}); renderOverview(); }
    if (state.tab === 'accounts') renderAccounts();
    if (state.tab === 'providers') renderProviders();
  } catch (err) {
    if (!silent) toast(err.message, 'bad');
  } finally {
    state.refreshing = false;
  }
}

/* ------------------------------------------------------------------ */
/* boot / login                                                        */
/* ------------------------------------------------------------------ */

function showLogin(message = '') {
  $('#login-view').hidden = false;
  $('#app-view').hidden = true;
  $('#login-error').textContent = message;
  $('#login-token').value = state.token || '';
  setTimeout(() => $('#login-token').focus(), 60);
}

function showApp() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  renderIcons();
  showTab(state.tab, { skipLoad: true });
  loadAll().catch((err) => toast(err.message, 'bad'));
}

async function loadAll() {
  await loadConfig();
  await Promise.all([loadStats(), loadKeys(), loadProviders()]);
  $('#side-version').textContent = `v${state.config.appVersion || '1.0.0'}`;
  renderSidebar();
  await renderCurrent();
}

async function tryConnect(token) {
  state.token = token;
  $('#login-btn').disabled = true;
  $('#login-btn').textContent = 'Connecting…';
  try {
    await loadConfig();
    localStorage.setItem('blue_token', token);
    $('#login-btn').disabled = false;
    $('#login-btn').textContent = 'Open dashboard';
    showApp();
  } catch (err) {
    localStorage.removeItem('blue_token');
    showLogin(err.message === 'Failed to fetch' ? 'Cannot reach the server.' : err.message);
    $('#login-btn').disabled = false;
    $('#login-btn').textContent = 'Open dashboard';
  }
}

function logout(expired = false) {
  localStorage.removeItem('blue_token');
  state.token = '';
  state.config = null;
  state.keys = [];
  state.stats = null;
  state.providers = [];
  state.models = [];
  state.logs = [];
  state.chat = [];
  showLogin(expired ? 'Please sign in again.' : '');
}

/* ------------------------------------------------------------------ */
/* sidebar + tabs                                                      */
/* ------------------------------------------------------------------ */

const TAB_META = {
  overview: ['Overview', 'Everything at a glance'],
  accounts: ['Accounts', 'Every key behind one API'],
  providers: ['Providers', 'Where your requests can go'],
  playground: ['Playground', 'Send a real request through your gateway'],
  models: ['Models', 'Available across your accounts'],
  logs: ['Requests', 'Live request log'],
  settings: ['Settings', 'Routing, keys and server'],
};

function renderSidebar() {
  const active = state.keys.filter((k) => k.enabled).length;
  $('#nav-accounts').textContent = String(state.keys.length);
  const pill = $('#gateway-pill');
  pill.classList.toggle('online', !!state.stats);
  pill.classList.toggle('offline', !state.stats);
  const providers = new Set(state.keys.map((k) => k.provider)).size;
  $('#gateway-text').textContent = state.stats
    ? `${active}/${state.keys.length} accounts · ${providers} providers`
    : 'connecting…';
}

function showTab(tab, { skipLoad = false } = {}) {
  if (!TAB_META[tab]) return;
  state.tab = tab;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab').forEach((s) => { s.hidden = s.dataset.tab !== tab; });
  $('#page-title').textContent = TAB_META[tab][0];
  $('#page-sub').textContent = TAB_META[tab][1];
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  if (!skipLoad) renderCurrent().catch((err) => toast(err.message, 'bad'));
}

async function renderCurrent() {
  switch (state.tab) {
    case 'overview': await renderOverview(); break;
    case 'accounts': await renderAccounts(); break;
    case 'providers': await renderProviders(); break;
    case 'playground': await renderPlayground(); break;
    case 'models': await renderModels(); break;
    case 'logs': await renderLogs(); break;
    case 'settings': await renderSettings(); break;
    default: break;
  }
}

/* ------------------------------------------------------------------ */
/* overview                                                            */
/* ------------------------------------------------------------------ */

function providerLabel(id) {
  const p = state.providers.find((x) => x.id === id);
  return p ? p.label : id;
}

function statusOf(k) {
  if (!k.enabled) return { cls: 'off', text: 'disabled' };
  if (k.cooldownMs > 0) {
    const h = k.health && k.health.status;
    if (h === 'invalid-key') return { cls: 'bad', text: `bad key · ${humanDuration(k.cooldownMs)}` };
    if (h === 'rate-limited') return { cls: 'warn', text: `rate limited · ${humanDuration(k.cooldownMs)}` };
    return { cls: 'warn', text: `cooling · ${humanDuration(k.cooldownMs)}` };
  }
  const h = k.health && k.health.status;
  if (h === 'ok') return { cls: 'ok', text: 'active' };
  if (h === 'invalid-key') return { cls: 'bad', text: 'invalid key' };
  if (h === 'error') return { cls: 'bad', text: 'error' };
  if (k.stats && k.stats.success > 0) return { cls: 'ok', text: 'active' };
  return { cls: 'off', text: 'unchecked' };
}

async function renderOverview() {
  if (!state.logs.length) await loadLogs().catch(() => {});
  const s = state.stats;
  const keys = state.keys;
  $('#hero').hidden = keys.length > 0;

  if (s) {
    $('#ov-requests').textContent = humanNumber(s.totals.requests);
    $('#ov-requests-sub').textContent = s.lastHour.requests
      ? `${humanNumber(s.lastHour.requests)} in the last hour`
      : 'no traffic in the last hour';
    const rate = s.totals.requests ? Math.round((s.totals.success / s.totals.requests) * 100) : null;
    $('#ov-success').textContent = rate == null ? '—' : `${rate}%`;
    $('#ov-success-sub').textContent = s.totals.requests ? `${humanNumber(s.totals.fail)} failed` : 'waiting for traffic';
    $('#ov-tokens').textContent = humanNumber((s.totals.tokensIn || 0) + (s.totals.tokensOut || 0));
    $('#ov-tokens-sub').textContent = `${humanNumber(s.totals.tokensIn)} in / ${humanNumber(s.totals.tokensOut)} out`;
    $('#ov-latency').textContent = s.recentLatencyMs != null ? `${s.recentLatencyMs} ms` : '—';
    $('#ov-latency-sub').textContent = s.minute.count ? `${s.minute.count} req this minute` : 'last requests';

    /* provider bars */
    const rows = (s.providers || []).slice().sort((a, b) => b.requests - a.requests);
    const max = Math.max(1, ...rows.map((r) => r.requests));
    $('#ov-bars').innerHTML = rows.length
      ? rows.map((p) => `
        <div class="bar-row">
          <span class="bar-name" title="${esc(p.label)}">${esc(p.label)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${Math.max(2, Math.round((p.requests / max) * 100))}%"></span></span>
          <span class="bar-value">${humanNumber(p.requests)} req</span>
        </div>`).join('')
      : '<p class="muted">No providers have accounts yet.</p>';

    /* routing summary */
    const cooling = keys.filter((k) => k.cooldownMs > 0).length;
    const active = keys.filter((k) => k.enabled).length;
    $('#ov-routing').innerHTML = `
      <dt>Mode</dt><dd>${esc(s.routing.mode)}</dd>
      <dt>Failover</dt><dd>${esc(s.routing.maxRetries)} retries</dd>
      <dt>Cooldown</dt><dd>${humanDuration(Number(s.routing.cooldownSeconds) * 1000)}</dd>
      <dt>Accounts</dt><dd>${active} active${cooling ? ` · ${cooling} cooling` : ''}</dd>
      <dt>Uptime</dt><dd>${humanDuration(s.uptimeMs)}</dd>
      <dt>Version</dt><dd>v${esc(s.version)}</dd>`;

    $('#ov-endpoint').textContent = endpointBase();
    const key = state.config ? state.config.clientKey : 'blue_…';
    $('#ov-curl').textContent = `curl ${endpointBase()}/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"llama-3.3-70b-versatile","messages":[{"role":"user","content":"Hello"}]}'`;
  }

  /* recent requests */
  const body = $('#ov-recent');
  if (!state.logs.length) {
    body.innerHTML = '<tr><td colspan="7" class="muted" style="padding:18px 10px">No requests yet — try the Playground or call the API.</td></tr>';
  } else {
    body.innerHTML = state.logs.slice(0, 8).map((l) => `
      <tr>
        <td class="mono">${esc(clock(l.ts))}</td>
        <td>${esc(providerLabel(l.provider))}</td>
        <td>${esc(l.account || '—')}</td>
        <td class="mono truncate" title="${esc(l.model)}">${esc(l.model || '—')}</td>
        <td class="status-cell">${l.ok ? '<span class="chip ok">200</span>' : `<span class="chip bad">${esc(l.status)}</span>`}</td>
        <td class="num">${l.ms != null ? `${l.ms} ms` : '—'}</td>
        <td class="num">${humanNumber((l.tokensIn || 0) + (l.tokensOut || 0))}</td>
      </tr>`).join('');
  }
  renderSidebar();
}

/* ------------------------------------------------------------------ */
/* accounts                                                            */
/* ------------------------------------------------------------------ */

function fillProviderSelects() {
  const options = state.providers.map((p) => `<option value="${esc(p.id)}"${p.accounts ? '' : ''}>${esc(p.label)}${p.canAdd ? '' : ''}</option>`).join('');
  const addSel = $('#add-provider');
  if (addSel && addSel.dataset.filled !== '1') {
    addSel.innerHTML = options;
    addSel.dataset.filled = '1';
  }
  const filter = $('#acc-filter');
  if (filter && filter.dataset.filled !== '1') {
    filter.innerHTML = `<option value="">All providers</option>${state.providers.map((p) => `<option value="${esc(p.id)}">${esc(p.label)} (${p.accounts})</option>`).join('')}`;
    filter.dataset.filled = '1';
  }
  const logSel = $('#log-provider');
  if (logSel && logSel.dataset.filled !== '1') {
    logSel.innerHTML = `<option value="">All providers</option>${state.providers.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('')}`;
    logSel.dataset.filled = '1';
  }
  const pgSel = $('#pg-provider');
  if (pgSel && pgSel.dataset.filled !== '1') {
    pgSel.innerHTML = `<option value="">Auto — best account</option>${state.providers.filter((p) => p.accounts).map((p) => `<option value="${esc(p.id)}">${esc(p.label)} (${p.accounts})</option>`).join('')}`;
    pgSel.dataset.filled = '1';
  }
}

function updateAddHint() {
  const id = $('#add-provider').value;
  const p = state.providers.find((x) => x.id === id);
  if (!p) return;
  const bits = [];
  if (p.quota && p.quota.requestsPerMinute) bits.push(p.quota.requestsPerMinute);
  if (p.quota && p.quota.tokensPerDay) bits.push(p.quota.tokensPerDay);
  if (p.authStyle === 'none') bits.push('no key needed — just add a placeholder like "local"');
  $('#add-hint').textContent = bits.join(' · ') || `Base URL: ${p.baseUrl || 'not set'}`;
}

async function renderAccounts() {
  if (!state.providers.length) await loadProviders();
  fillProviderSelects();
  updateAddHint();
  const filter = $('#acc-filter').value || state.filter.provider;
  const q = ($('#acc-search').value || state.filter.q).toLowerCase().trim();
  const rows = state.keys.filter((k) => {
    if (filter && k.provider !== filter) return false;
    if (!q) return true;
    return `${k.name} ${k.provider} ${k.masked} ${k.id}`.toLowerCase().includes(q);
  });

  $('#accounts-empty').hidden = state.keys.length > 0;
  const body = $('#accounts-body');
  if (!state.keys.length) {
    body.innerHTML = '';
    return;
  }
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="8" class="muted" style="padding:18px 10px">No account matches this filter.</td></tr>';
    return;
  }
  body.innerHTML = rows.map((k) => {
    const st = statusOf(k);
    return `
      <tr data-id="${esc(k.id)}">
        <td>
          <span class="acct-name"><span class="strong">${esc(k.name)}</span><small>${esc(k.id)}</small></span>
        </td>
        <td>${esc(providerLabel(k.provider))}</td>
        <td class="mono">${esc(k.masked)}</td>
        <td class="status-cell"><span class="chip ${st.cls}"${k.lastError ? ` title="${esc(k.lastError)}"` : ''}>${esc(st.text)}</span></td>
        <td class="num">${humanNumber(k.stats.requests)}</td>
        <td class="num" title="${nf.format(k.stats.tokensIn)} in / ${nf.format(k.stats.tokensOut)} out">${humanNumber(k.stats.tokensIn + k.stats.tokensOut)}</td>
        <td class="mono">${esc(ago(k.lastUsedAt))}</td>
        <td class="actions-col">
          <span class="acct-actions">
            <button class="icon-btn" data-act="check" data-id="${esc(k.id)}" title="Health check"><span data-icon="refresh"></span></button>
            <button class="icon-btn" data-act="toggle" data-id="${esc(k.id)}" title="${k.enabled ? 'Disable' : 'Enable'}"><span data-icon="power"></span></button>
            <button class="icon-btn" data-act="rename" data-id="${esc(k.id)}" title="Rename"><span data-icon="pencil"></span></button>
            <button class="icon-btn danger" data-act="delete" data-id="${esc(k.id)}" title="Remove"><span data-icon="trash"></span></button>
          </span>
        </td>
      </tr>`;
  }).join('');
  renderIcons(body);
}

async function addAccounts(event) {
  event.preventDefault();
  const provider = $('#add-provider').value;
  const keys = $('#add-keys').value.split(/[\s,;]+/).map((k) => k.trim()).filter(Boolean);
  const prefix = $('#add-name').value.trim();
  if (!provider) return toast('Pick a provider first', 'warn');
  if (!keys.length) return toast('Paste at least one API key', 'warn');
  const btn = $('#add-form button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Adding…';
  let added = 0;
  const errors = [];
  const label = providerLabel(provider);
  for (let i = 0; i < keys.length; i += 1) {
    const name = prefix
      ? (keys.length > 1 ? `${prefix}-${i + 1}` : prefix)
      : `${label} #${state.keys.length + i + 1}`;
    try {
      // eslint-disable-next-line no-await-in-loop
      await admin('/keys', { method: 'POST', body: { provider, key: keys[i], name } });
      added += 1;
    } catch (err) {
      errors.push(`${keys[i].slice(0, 8)}…: ${err.message}`);
    }
  }
  btn.disabled = false;
  btn.textContent = 'Add account(s)';
  $('#add-keys').value = '';
  await Promise.all([loadKeys(), loadProviders(), loadStats()]);
  fillProviderSelects();
  renderAccounts();
  renderSidebar();
  if (added) toast(`${added} account${added > 1 ? 's' : ''} added — health checks are running`, 'ok');
  if (errors.length) toast(errors[0], 'bad');
}

async function accountAction(act, id) {
  const key = state.keys.find((k) => k.id === id);
  if (!key) return;
  try {
    if (act === 'check') {
      const row = $(`tr[data-id="${id}"]`);
      if (row) row.style.opacity = '0.55';
      const res = await admin(`/keys/${id}/check`, { method: 'POST' });
      await Promise.all([loadKeys(), loadStats()]);
      renderAccounts();
      const r = res.data;
      toast(r.ok ? `${key.name} is working${r.latencyMs ? ` (${Math.round(r.latencyMs)} ms)` : ''}` : `${key.name}: ${r.detail || r.status}`, r.ok ? 'ok' : 'bad');
    } else if (act === 'toggle') {
      await admin(`/keys/${id}/${key.enabled ? 'disable' : 'enable'}`, { method: 'POST' });
      await loadKeys();
      renderAccounts();
      renderSidebar();
      toast(`${key.name} ${key.enabled ? 'disabled' : 'enabled'}`, 'ok');
    } else if (act === 'rename') {
      const name = await promptDialog('Rename account', { label: `Name for ${key.name}`, value: key.name });
      if (!name) return;
      await admin(`/keys/${id}/rename`, { method: 'POST', body: { name } });
      await loadKeys();
      renderAccounts();
      toast('Renamed', 'ok');
    } else if (act === 'delete') {
      const ok = await confirmDialog('Remove account', `Remove <strong>${esc(key.name)}</strong> (${esc(key.provider)})? Requests stop using this key immediately.`, 'Remove');
      if (!ok) return;
      await admin(`/keys/${id}`, { method: 'DELETE' });
      await Promise.all([loadKeys(), loadProviders(), loadStats()]);
      renderAccounts();
      renderSidebar();
      toast('Account removed', 'ok');
    }
  } catch (err) {
    toast(err.message, 'bad');
    if (act === 'check') {
      const row = $(`tr[data-id="${id}"]`);
      if (row) row.style.opacity = '1';
    }
  }
}

async function bulkCheck() {
  const btn = $('#bulk-check');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const res = await admin('/check-all', { method: 'POST' });
    await Promise.all([loadKeys(), loadStats()]);
    renderAccounts();
    const good = res.data.filter((r) => r.ok).length;
    toast(`${good}/${res.data.length} accounts working`, good === res.data.length ? 'ok' : 'warn');
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check all';
  }
}

/* ------------------------------------------------------------------ */
/* providers                                                           */
/* ------------------------------------------------------------------ */

async function renderProviders() {
  await loadProviders();
  const grid = $('#provider-grid');
  grid.innerHTML = state.providers.map((p) => `
    <article class="provider-card${p.enabled ? '' : ' off'}" data-provider="${esc(p.id)}">
      <div class="pc-head">
        <div class="pc-title">
          <strong>${esc(p.label)}</strong>
          <small>${esc(p.id)}</small>
        </div>
        <label class="switch-row compact" title="${p.enabled ? 'Disable provider' : 'Enable provider'}">
          <input type="checkbox" data-pact="toggle" data-id="${esc(p.id)}" ${p.enabled ? 'checked' : ''}>
        </label>
      </div>
      <div class="pc-stats">
        <span><b>${p.accounts}</b> accounts</span>
        <span><b>${humanNumber(p.daily ? p.daily.requests : 0)}</b> requests today</span>
      </div>
      <div class="pc-quota">
        <span>${esc((p.quota && p.quota.requestsPerMinute) || 'rate limit unknown')}</span>
        <span>${esc((p.quota && p.quota.tokensPerDay) || '—')}</span>
        ${p.quota && p.quota.note ? `<span>${esc(p.quota.note)}</span>` : ''}
      </div>
      <div class="pc-foot">
        <button class="btn tiny" data-pact="add" data-id="${esc(p.id)}">Add key</button>
        <button class="btn tiny ghost" data-pact="base" data-id="${esc(p.id)}">Base URL</button>
        ${p.docs ? `<a class="link" href="${esc(p.docs)}" target="_blank" rel="noopener">Docs ↗</a>` : ''}
        <span class="spacer"></span>
        <span class="muted" style="font-size:10.5px">${esc((p.models || []).length)} models</span>
      </div>
      <div class="muted" style="font-size:10.5px;word-break:break-all" title="base URL">${esc(p.baseUrl || 'base URL not set')}</div>
    </article>`).join('');
  renderIcons(grid);
}

async function providerAction(act, id, el) {
  const p = state.providers.find((x) => x.id === id);
  if (!p) return;
  try {
    if (act === 'toggle') {
      const enabled = el.checked;
      await admin(`/providers/${id}`, { method: 'PATCH', body: { enabled } });
      await loadProviders();
      renderProviders();
      toast(`${p.label} ${enabled ? 'enabled' : 'disabled'}`, 'ok');
    } else if (act === 'add') {
      showTab('accounts');
      fillProviderSelects();
      $('#add-provider').value = id;
      updateAddHint();
      $('#add-keys').focus();
    } else if (act === 'base') {
      const value = await promptDialog(`Base URL — ${p.label}`, {
        label: 'OpenAI-compatible base URL',
        value: p.baseUrl || '',
        hint: 'For custom providers, set this to the full /v1 endpoint, e.g. https://api.example.com/v1',
      });
      if (value == null) return;
      await admin(`/providers/${id}`, { method: 'PATCH', body: { baseUrl: value } });
      await loadProviders();
      renderProviders();
      toast('Base URL updated', 'ok');
    }
  } catch (err) {
    toast(err.message, 'bad');
  }
}

/* ------------------------------------------------------------------ */
/* playground                                                          */
/* ------------------------------------------------------------------ */

function modelPool() {
  const set = new Set();
  for (const g of state.models) for (const m of g.models) set.add(m);
  if (!set.size) for (const p of state.providers) for (const m of p.models || []) set.add(m);
  return [...set];
}

async function renderPlayground() {
  if (!state.modelsLoaded) {
    await loadModels().catch(() => {});
  }
  fillProviderSelects();
  const sel = $('#pg-model');
  const pool = modelPool();
  const current = sel.value;
  if (state.config.routing.forceModel) {
    pool.unshift(state.config.routing.forceModel);
  }
  sel.innerHTML = pool.length
    ? [...new Set(pool)].map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('')
    : '<option value="">add an account to load models</option>';
  if (current && [...sel.options].some((o) => o.value === current)) sel.value = current;
  if (!sel.value && pool.length) sel.value = pool[0];
  renderChat();
}

function renderChat() {
  const box = $('#pg-chat');
  if (!state.chat.length) {
    box.innerHTML = `
      <div class="chat-empty">
        <span class="ico big" data-icon="play"></span>
        <h3>Send a request through your gateway</h3>
        <p class="muted">It picks the healthiest account automatically. The provider and account that answered shows below each reply.</p>
      </div>`;
    renderIcons(box);
    return;
  }
  box.innerHTML = state.chat.map((m, i) => `
    <div class="msg ${m.role}${m.error ? ' error' : ''}" data-i="${i}">
      <div class="bubble${m.pending ? ' typing' : ''}">${esc(m.content)}</div>
      ${m.meta ? `<div class="meta">${esc(m.meta)}</div>` : ''}
    </div>`).join('');
  scrollChat();
}

function scrollChat() {
  const box = $('#pg-chat');
  box.scrollTop = box.scrollHeight;
}

function updateChatBubble(index) {
  const node = $(`#pg-chat .msg[data-i="${index}"]`);
  if (!node) return renderChat();
  const msg = state.chat[index];
  const bubble = node.querySelector('.bubble');
  if (bubble) {
    bubble.textContent = msg.content;
    bubble.classList.toggle('typing', !!msg.pending);
  }
  scrollChat();
}

async function sendChat(event) {
  if (event) event.preventDefault();
  const input = $('#pg-input');
  const text = input.value.trim();
  if (!text || state.busy) return;
  if (!state.config) return;

  const history = state.chat.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));
  state.chat.push({ role: 'user', content: text });
  const assistantIndex = state.chat.length;
  state.chat.push({ role: 'assistant', content: '', pending: true });
  input.value = '';
  autoGrow(input);
  renderChat();

  const provider = $('#pg-provider').value;
  const model = $('#pg-model').value;
  const stream = $('#pg-stream').checked;
  const max = Number($('#pg-max').value) || 512;
  const started = performance.now();
  state.busy = true;
  $('#pg-send').disabled = true;
  $('#pg-send').textContent = '…';

  try {
    const url = `/v1/chat/completions${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${state.config.clientKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        stream,
        max_tokens: max,
        messages: [...history, { role: 'user', content: text }],
      }),
    });

    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error((json.error && json.error.message) || `HTTP ${res.status}`);
    }

    const servedBy = `${res.headers.get('x-bluerouter-provider') || '?'} · ${res.headers.get('x-bluerouter-account') || '?'}`;

    if (stream && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let content = '';
      let usage = null;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx = buf.indexOf('\n\n');
        while (idx !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          idx = buf.indexOf('\n\n');
          const payload = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          if (!payload || payload === '[DONE]') continue;
          let evt;
          try { evt = JSON.parse(payload); } catch { continue; }
          if (evt.usage) usage = evt.usage;
          const delta = evt.choices && evt.choices[0] && evt.choices[0].delta;
          if (delta && typeof delta.content === 'string' && delta.content) {
            content += delta.content;
            state.chat[assistantIndex].content = content;
            updateChatBubble(assistantIndex);
          }
        }
      }
      const ms = Math.round(performance.now() - started);
      const tokens = usage ? `${usage.prompt_tokens || 0}+${usage.completion_tokens || 0} tok` : '';
      state.chat[assistantIndex].content = content || '(empty response)';
      state.chat[assistantIndex].pending = false;
      state.chat[assistantIndex].meta = `${servedBy} · ${ms} ms${tokens ? ` · ${tokens}` : ''} · streamed`;
      renderChat();
      $('#pg-last').textContent = `provider  ${servedBy.replace(' · ', '\naccount  ')}\nlatency   ${ms} ms${tokens ? `\ntokens    ${tokens}` : ''}`;
    } else {
      const json = await res.json();
      const content = json.choices && json.choices[0] && json.choices[0].message
        ? (json.choices[0].message.content || '(empty response)')
        : '(no content)';
      const ms = Math.round(performance.now() - started);
      const usage = json.usage || {};
      state.chat[assistantIndex].content = content;
      state.chat[assistantIndex].pending = false;
      state.chat[assistantIndex].meta = `${servedBy} · ${ms} ms · ${usage.prompt_tokens || 0}+${usage.completion_tokens || 0} tok`;
      renderChat();
      $('#pg-last').textContent = `provider  ${servedBy.replace(' · ', '\naccount  ')}\nmodel     ${json.model || model}\nlatency   ${ms} ms\ntokens    ${usage.prompt_tokens || 0} in / ${usage.completion_tokens || 0} out`;
    }
    refreshCore().catch(() => {});
  } catch (err) {
    state.chat[assistantIndex].pending = false;
    state.chat[assistantIndex].error = true;
    state.chat[assistantIndex].content = err.message;
    state.chat[assistantIndex].meta = 'request failed';
    renderChat();
    $('#pg-last').textContent = `error\n${err.message}`;
    toast(err.message, 'bad');
  } finally {
    state.busy = false;
    $('#pg-send').disabled = false;
    $('#pg-send').textContent = 'Send';
    $('#pg-input').focus();
  }
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}

/* ------------------------------------------------------------------ */
/* models                                                              */
/* ------------------------------------------------------------------ */

async function renderModels(fresh = false) {
  if (!state.modelsLoaded || fresh) {
    const box = $('#model-groups');
    box.innerHTML = '<p class="muted">Loading models from your accounts…</p>';
    await loadModels(fresh);
  }
  const box = $('#model-groups');
  if (!state.models.length) {
    box.innerHTML = `
      <div class="panel empty">
        <span class="empty-ico" data-icon="cpu"></span>
        <h3>No models yet</h3>
        <p class="muted">Add an account and this page fills with every model your providers expose.</p>
      </div>`;
    renderIcons(box);
    return;
  }
  box.innerHTML = state.models.map((g) => `
    <section class="model-group">
      <div class="mg-head">
        <strong>${esc(g.label)}</strong>
        <span class="chip ${g.live ? 'ok' : 'off'}">${g.live ? 'live' : 'configured'}</span>
        <span class="muted" style="font-size:11.5px">${g.models.length} models</span>
      </div>
      <div class="chips">
        ${g.models.map((m) => `<button class="model-chip" data-model="${esc(m)}" title="Copy model id">${esc(m)}</button>`).join('')}
      </div>
    </section>`).join('');
}

/* ------------------------------------------------------------------ */
/* logs                                                                */
/* ------------------------------------------------------------------ */

async function renderLogs() {
  await loadLogs();
  fillProviderSelects();
  const body = $('#logs-body');
  $('#logs-empty').hidden = state.logs.length > 0;
  if (!state.logs.length) {
    body.innerHTML = '';
    return;
  }
  body.innerHTML = state.logs.map((l) => `
    <tr>
      <td class="mono">${esc(clock(l.ts))}</td>
      <td>${esc(providerLabel(l.provider))}</td>
      <td class="mono">${esc(l.account || '—')}</td>
      <td class="mono truncate" style="max-width:180px" title="${esc(l.model)}">${esc(l.model || '—')}</td>
      <td class="status-cell">${l.ok ? `<span class="chip ok">${esc(l.status)}</span>` : `<span class="chip bad">${esc(l.status)}</span>`}</td>
      <td class="num">${l.ms != null ? l.ms : '—'}</td>
      <td class="num">${humanNumber((l.tokensIn || 0) + (l.tokensOut || 0))}</td>
      <td><span class="wrap" title="${esc(l.error || l.prompt || '')}">${esc(l.error || l.prompt || (l.stream ? 'stream' : '—'))}</span></td>
    </tr>`).join('');
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

async function renderSettings() {
  await loadConfig();
  const c = state.config;
  const s = state.stats;
  $('#set-base').textContent = endpointBase();
  $('#set-clientkey').textContent = c.clientKey;
  $('#set-admin').textContent = `${c.adminToken.slice(0, 12)}…${c.adminToken.slice(-4)}`;
  $('#set-datadir').textContent = c.dataDir;
  $('#set-version').textContent = `v${c.appVersion || '1.0.0'} · node ${c.node || ''}`;

  $('#set-mode').value = c.routing.mode;
  $('#set-retries').value = c.routing.maxRetries;
  $('#set-cooldown').value = c.routing.cooldownSeconds;
  $('#set-timeout').value = Math.round((Number(c.routing.timeoutMs) || 180000) / 1000);
  $('#set-force').value = c.routing.forceModel || '';
  $('#set-port').value = c.port;
  $('#set-maxlogs').value = c.requestLog.maxEntries;
  $('#set-logging').checked = !!c.requestLog.enabled;

  $('#set-server').innerHTML = `
    <dt>Uptime</dt><dd>${s ? humanDuration(s.uptimeMs) : '—'}</dd>
    <dt>Host</dt><dd>${esc((s && s.host) || location.hostname)}</dd>
    <dt>Node</dt><dd>${esc(s ? s.node : (c.node || '—'))}</dd>
    <dt>Platform</dt><dd>${esc(c.platform || '—')}</dd>
    <dt>Memory</dt><dd>${s ? `${Math.round(s.memory.rss / 1048576)} MB` : '—'}</dd>
    <dt>Config file</dt><dd class="mono" style="font-size:11px">${esc(c.configPath || '—')}</dd>`;
}

async function saveRouting() {
  const body = {
    routing: {
      mode: $('#set-mode').value,
      maxRetries: Number($('#set-retries').value) || 3,
      cooldownSeconds: Number($('#set-cooldown').value) || 300,
      timeoutMs: (Number($('#set-timeout').value) || 180) * 1000,
      forceModel: $('#set-force').value.trim(),
    },
  };
  $('#save-routing').disabled = true;
  try {
    await admin('/config', { method: 'PATCH', body });
    await loadConfig();
    $('#routing-saved').textContent = 'Saved just now';
    toast('Routing saved', 'ok');
    refreshCore().catch(() => {});
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    $('#save-routing').disabled = false;
  }
}

async function saveServer() {
  const body = {
    port: Number($('#set-port').value) || 1212,
    requestLog: {
      enabled: $('#set-logging').checked,
      maxEntries: Number($('#set-maxlogs').value) || 2000,
    },
  };
  $('#save-server').disabled = true;
  try {
    const res = await admin('/config', { method: 'PATCH', body });
    await loadConfig();
    $('#server-saved').textContent = res.restartRequired ? 'Restart with: blue restart' : 'Saved just now';
    toast(res.restartRequired ? 'Saved — restart BlueRouter to change the port' : 'Settings saved', 'ok');
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    $('#save-server').disabled = false;
  }
}

async function exportConfig() {
  try {
    const res = await fetch('/admin/export', { headers: { authorization: `Bearer ${state.token}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bluerouter-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Config exported (contains your keys — keep it safe)', 'warn');
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function importConfig(file) {
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    const ok = await confirmDialog(
      'Import configuration',
      `Replace the current setup with this file? It contains <strong>${(json.keys || []).length}</strong> account(s). Existing accounts are overwritten.`,
      'Import',
    );
    if (!ok) return;
    await admin('/import', { method: 'POST', body: { config: json } });
    await loadAll();
    toast('Configuration imported', 'ok');
  } catch (err) {
    toast(`Import failed: ${err.message}`, 'bad');
  }
}

/* ------------------------------------------------------------------ */
/* events                                                              */
/* ------------------------------------------------------------------ */

function bindEvents() {
  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const token = $('#login-token').value.trim();
    if (!token) return;
    tryConnect(token);
  });

  $('#logout-btn').addEventListener('click', () => logout());

  $('#nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (btn) showTab(btn.dataset.tab);
  });

  document.body.addEventListener('click', (e) => {
    const goto = e.target.closest('[data-goto]');
    if (goto) showTab(goto.dataset.goto);

    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      const what = copyBtn.dataset.copy;
      const c = state.config || {};
      if (what === 'endpoint') copyText(endpointBase());
      else if (what === 'clientkey') copyText(c.clientKey || '');
      else if (what === 'admin') copyText(c.adminToken || '');
      else if (what === 'curl') copyText($('#ov-curl').textContent);
    }

    const close = e.target.closest('[data-modal-close]');
    if (close) closeModal();

    const model = e.target.closest('.model-chip');
    if (model) copyText(model.dataset.model);
  });

  $('#refresh-btn').addEventListener('click', async () => {
    const btn = $('#refresh-btn');
    btn.disabled = true;
    try {
      await Promise.all([loadConfig(), loadStats(), loadKeys(), loadProviders()]);
      if (state.tab === 'logs') await loadLogs();
      await renderCurrent();
      toast('Refreshed', 'ok');
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      btn.disabled = false;
    }
  });

  /* accounts */
  $('#add-form').addEventListener('submit', addAccounts);
  $('#add-provider').addEventListener('change', updateAddHint);
  $('#acc-filter').addEventListener('change', (e) => {
    state.filter.provider = e.target.value;
    renderAccounts().catch(() => {});
  });
  $('#acc-search').addEventListener('input', (e) => {
    state.filter.q = e.target.value;
    renderAccounts().catch(() => {});
  });
  $('#accounts-body').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn) accountAction(btn.dataset.act, btn.dataset.id);
  });
  $('#bulk-check').addEventListener('click', bulkCheck);
  $('#reset-cooldowns').addEventListener('click', async () => {
    try {
      await admin('/cooldowns/clear', { method: 'POST' });
      await Promise.all([loadKeys(), loadStats()]);
      renderAccounts();
      toast('Cooldowns cleared — every account is eligible', 'ok');
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  /* providers */
  $('#provider-grid').addEventListener('change', (e) => {
    const input = e.target.closest('[data-pact="toggle"]');
    if (input) providerAction('toggle', input.dataset.id, input);
  });
  $('#provider-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-pact]');
    if (btn && btn.dataset.pact !== 'toggle') providerAction(btn.dataset.pact, btn.dataset.id, btn);
  });

  /* playground */
  $('#pg-form').addEventListener('submit', sendChat);
  $('#pg-input').addEventListener('input', (e) => autoGrow(e.target));
  $('#pg-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });
  $('#pg-clear').addEventListener('click', () => {
    state.chat = [];
    renderChat();
    $('#pg-last').textContent = 'No requests yet.';
  });

  /* models */
  $('#models-refresh').addEventListener('click', async () => {
    const btn = $('#models-refresh');
    btn.disabled = true;
    try {
      await renderModels(true);
      toast('Live model list refreshed', 'ok');
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      btn.disabled = false;
    }
  });

  /* logs */
  $('#log-provider').addEventListener('change', (e) => {
    state.logFilter.provider = e.target.value;
    renderLogs().catch(() => {});
  });
  $('#log-limit').addEventListener('change', (e) => {
    state.logFilter.limit = Number(e.target.value) || 100;
    renderLogs().catch(() => {});
  });
  $('#log-errors').addEventListener('change', (e) => {
    state.logFilter.errors = e.target.checked;
    renderLogs().catch(() => {});
  });
  $('#logs-refresh').addEventListener('click', () => renderLogs().catch((err) => toast(err.message, 'bad')));
  $('#logs-clear').addEventListener('click', async () => {
    const ok = await confirmDialog('Clear request log', 'Delete every logged request? Usage totals stay.', 'Clear');
    if (!ok) return;
    try {
      await admin('/logs', { method: 'DELETE' });
      state.logs = [];
      renderLogs();
      toast('Request log cleared', 'ok');
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  /* settings */
  $('#save-routing').addEventListener('click', saveRouting);
  $('#save-server').addEventListener('click', saveServer);
  $('#export-config').addEventListener('click', exportConfig);
  $('#import-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importConfig(file);
    e.target.value = '';
  });
  $('#clear-requests').addEventListener('click', async () => {
    const ok = await confirmDialog('Clear request log', 'Delete every logged request?', 'Clear');
    if (!ok) return;
    try {
      await admin('/logs', { method: 'DELETE' });
      state.logs = [];
      toast('Request log cleared', 'ok');
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
  $('#rotate-key').addEventListener('click', async () => {
    const ok = await confirmDialog(
      'Rotate client API key',
      'Every app using the current key stops working until you update it. Continue?',
      'Rotate',
    );
    if (!ok) return;
    try {
      const res = await admin('/rotate-client-key', { method: 'POST' });
      await loadConfig();
      renderSettings();
      revealDialog('New client API key', res.clientKey, 'Update your apps now — the old key is already invalid.');
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

function init() {
  renderIcons();
  bindEvents();

  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const hashToken = hash.get('token');
  if (hashToken) {
    history.replaceState(null, '', location.pathname + location.search);
  }
  const saved = hashToken || localStorage.getItem('blue_token') || '';
  state.token = saved;
  if (saved) tryConnect(saved);
  else showLogin();

  setInterval(() => {
    if (!state.config || document.hidden) return;
    if (['overview', 'accounts', 'providers'].includes(state.tab)) refreshCore();
    if (state.tab === 'logs') renderLogs().catch(() => {});
  }, 6000);

  document.body.dataset.appReady = '1';

  window.addEventListener('hashchange', () => {
    const t = new URLSearchParams(location.hash.replace(/^#/, '')).get('token');
    if (t) {
      history.replaceState(null, '', location.pathname + location.search);
      tryConnect(t);
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
