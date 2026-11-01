'use strict';

/**
 * Dashboard UI test — runs the real HTML/CSS/JS in jsdom against a live
 * BlueRouter instance and a fake upstream.
 *
 * Optional dependency:
 *   npm install --no-save jsdom && node test/ui.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

let JSDOM;
let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch {
  console.log('\n  jsdom is not installed — skipping UI test.');
  console.log('  Run: npm install --no-save jsdom && node test/ui.js\n');
  process.exit(0);
}

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bluerouter-ui-'));
const PORT = Number(process.env.TEST_PORT || 12141);
const BASE = `http://127.0.0.1:${PORT}`;

const { start, shutdown } = require('../src/server');
const { Store } = require('../src/store');

const nodeFetch = global.fetch;
let mock;
let instance;
let dom;
const errors = [];
const passed = [];

function ok(name) { passed.push(name); console.log(`  \x1b[32m✔\x1b[0m ${name}`); }
function fail(name, err) { throw new Error(`${name}\n      ${err.message}`); }

function waitFor(fn, { timeout = 6000, interval = 60, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      try {
        const value = await fn();
        if (value) return resolve(value);
      } catch { /* keep waiting */ }
      if (Date.now() - started > timeout) return reject(new Error(`timeout waiting for ${label}`));
      return setTimeout(tick, interval);
    };
    tick();
  });
}

function mockServer() {
  return http.createServer((req, res) => {
    const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* ignore */ }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test-model' }, { id: 'llama-3.3-70b-versatile' }] }));
      }
      if (req.url === '/v1/chat/completions') {
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const ev = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
          ev({ id: 'chatcmpl-ui', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
          ev({ id: 'chatcmpl-ui', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: `Hello from ${key}` } }] });
          ev({ id: 'chatcmpl-ui', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } });
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'chatcmpl-ui',
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: `Hello from ${key}` }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
        }));
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"error":{"message":"not found"}}');
    });
  });
}

(async () => {
  console.log('\nBlueRouter dashboard UI test\n');

  mock = mockServer();
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockUrl = `http://127.0.0.1:${mock.address().port}/v1`;

  const bootstrap = new Store({ dataDir: DATA_DIR }).init();
  bootstrap.get().providers.custom = { enabled: true, baseUrl: mockUrl, protocol: 'openai', authStyle: 'bearer', models: ['test-model', 'llama-3.3-70b-versatile'], quota: {} };
  bootstrap.get().routing.forceModel = '';
  bootstrap.save();
  bootstrap.addKey({ provider: 'custom', key: 'key-one', name: 'groq-1' });
  bootstrap.addKey({ provider: 'custom', key: 'key-two', name: 'groq-2' });
  bootstrap.addKey({ provider: 'custom', key: 'key-three', name: 'groq-3' });
  bootstrap.save();

  instance = await start({ port: PORT, host: '127.0.0.1', dataDir: DATA_DIR, quiet: true });
  const { clientKey, adminToken } = instance.store.get();

  /* ---------------------------------------------------------- jsdom */

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => {
    const msg = String(err.message || err);
    if (/Not implemented|Could not parse CSS|Cross origin/i.test(msg)) return;
    errors.push(msg);
  });
  virtualConsole.on('error', (...args) => errors.push(args.join(' ')));

  dom = await JSDOM.fromURL(`${BASE}/`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? new URL(input, BASE).toString() : input;
        return nodeFetch(url, init);
      };
      window.Headers = Headers;
      window.Request = Request;
      window.Response = Response;
      window.AbortController = AbortController;
      window.scrollTo = () => {};
      window.HTMLElement.prototype.scrollTo = () => {};
    },
  });

  const { window } = dom;
  const { document } = window;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const click = (sel) => $(sel).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  try {
    /* login screen */
    await waitFor(() => document.body.dataset.appReady === '1' && $('#login-view') && !$('#login-view').hidden, { label: 'login screen' });
    ok('login screen renders without a token');

    $('#login-token').value = 'wrong-token';
    $('#login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => $('#login-error').textContent.trim().length > 0, { label: 'login error' });
    ok('wrong admin token is rejected with a readable error');

    $('#login-token').value = adminToken;
    $('#login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => !$('#app-view').hidden, { label: 'dashboard shell' });
    await waitFor(() => $('#nav-accounts').textContent === '3', { label: 'accounts in sidebar' });
    ok('admin token logs in and the sidebar shows 3 accounts');

    /* overview */
    await waitFor(() => $('#ov-endpoint').textContent.includes('/v1'), { label: 'endpoint' });
    await waitFor(() => $('#ov-bars').children.length > 0, { label: 'provider bars' });
    assert.strictEqual($('#ov-endpoint').textContent, `${BASE}/v1`);
    assert.ok($('#ov-curl').textContent.includes(clientKey));
    ok('overview renders endpoint, curl and provider bars');

    /* make some traffic so stats/logs have data */
    await nodeFetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'ping' }] }),
    });
    click('#refresh-btn');
    await waitFor(() => !$('#ov-requests').textContent.startsWith('0'), { timeout: 8000, label: 'requests stat' });
    ok('traffic shows up in the overview stats after refresh');

    /* accounts tab */
    click('[data-tab="accounts"]');
    await waitFor(() => $$('#accounts-body tr').length === 3, { label: 'account rows' });
    assert.ok($('#accounts-body').textContent.includes('groq-1'));
    assert.ok($('#accounts-body').textContent.includes('…') || $('#accounts-body').textContent.includes('•'));
    ok('accounts table lists every account with masked keys');

    /* add an account through the UI */
    $('#add-provider').value = 'custom';
    $('#add-keys').value = 'key-four\nkey-five';
    $('#add-name').value = 'groq-extra';
    $('#add-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => $$('#accounts-body tr').length === 5, { timeout: 8000, label: 'new account rows' });
    assert.strictEqual($('#nav-accounts').textContent, '5');
    ok('adding two keys from the form registers both accounts');

    /* health check action */
    const checkBtn = $('#accounts-body tr [data-act="check"]');
    checkBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await waitFor(() => $('#accounts-body').textContent.includes('active'), { timeout: 8000, label: 'health status' });
    ok('per-account health check updates the status chip');

    /* providers tab */
    click('[data-tab="providers"]');
    await waitFor(() => $$('#provider-grid .provider-card').length > 5, { label: 'provider cards' });
    const customCard = $('#provider-grid [data-provider="custom"]');
    assert.ok(customCard.textContent.includes('5 accounts'));
    ok('providers tab renders the catalog with account counts');

    /* models tab */
    click('[data-tab="models"]');
    await waitFor(() => $$('#model-groups .model-chip').length > 0, { timeout: 8000, label: 'model chips' });
    ok('models tab lists live models from the provider');

    /* logs tab */
    click('[data-tab="logs"]');
    await waitFor(() => $$('#logs-body tr').length > 0, { timeout: 8000, label: 'log rows' });
    assert.ok(/custom/i.test($('#logs-body').textContent));
    ok('request log shows the calls we made');

    /* playground */
    click('[data-tab="playground"]');
    await waitFor(() => $('#pg-model').options.length > 0, { label: 'model select' });
    $('#pg-model').value = 'test-model';
    $('#pg-input').value = 'hello gateway';
    $('#pg-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => $('.msg.assistant .bubble') && /Hello from key-/.test($('.msg.assistant .bubble').textContent), { timeout: 8000, label: 'chat reply' });
    assert.ok($('.msg.assistant .meta').textContent.includes('custom'));
    assert.ok($('#pg-last').textContent.includes('provider'));
    ok('playground sends a real request and shows who answered');

    /* settings */
    click('[data-tab="settings"]');
    await waitFor(() => $('#set-clientkey').textContent === clientKey, { label: 'settings keys' });
    assert.strictEqual($('#set-base').textContent, `${BASE}/v1`);
    assert.ok($('#set-server').textContent.includes('Uptime'));
    $('#set-retries').value = '5';
    click('#save-routing');
    await waitFor(() => instance.store.get().routing.maxRetries === 5, { timeout: 6000, label: 'routing saved' });
    ok('settings displays keys and saves routing changes');

    assert.deepStrictEqual(errors, [], `console errors: ${errors.join(' | ')}`);
    ok('no uncaught errors in the browser console');

    console.log(`\n  ${passed.length} UI checks passed\n`);
    dom.window.close();
    await shutdown(instance, 'TEST');
    await new Promise((r) => mock.close(r));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    process.exit(0);
  } catch (err) {
    console.error(`\n  \x1b[31m✖ ${err.message}\x1b[0m`);
    if (errors.length) console.error(`  console errors: ${errors.join(' | ')}`);
    try { dom.window.close(); } catch { /* ignore */ }
    try { await shutdown(instance, 'TEST'); } catch { /* ignore */ }
    try { mock.close(); } catch { /* ignore */ }
    console.error(`  data kept: ${DATA_DIR}\n`);
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
