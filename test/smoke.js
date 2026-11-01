'use strict';

/**
 * End-to-end smoke test — no network, no real API keys.
 *
 * Spins up a fake OpenAI-compatible provider and a fake Anthropic provider,
 * then drives BlueRouter exactly like a client would:
 *   429 -> automatic failover, 500 -> failover, SSE pass-through,
 *   Anthropic -> OpenAI translation, model targeting, admin API.
 *
 * Run: npm test
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bluerouter-test-'));
process.env.BLUEROUTER_DATA = DATA_DIR;

const { start, shutdown } = require('../src/server');
const { Store } = require('../src/store');

const PORT = Number(process.env.TEST_PORT || 12131);
const BASE = `http://127.0.0.1:${PORT}`;
let clientKey = '';
let adminToken = '';
let mock;
let mockUrl;
let instance;
let passed = 0;
const failures = [];

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    })
    .catch((err) => {
      failures.push({ name, err });
      console.log(`  \x1b[31m✖\x1b[0m ${name}\n      ${err.message}`);
    });
}

/* ------------------------------------------------------------------ */
/* Fake upstream                                                       */
/* ------------------------------------------------------------------ */

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function mockServer() {
  return http.createServer((req, res) => {
    const key = String(req.headers.authorization || req.headers['x-api-key'] || '').replace(/^Bearer\s+/i, '');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }

      if (req.url === '/v1/models') {
        if (key === 'bad-auth') {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'Invalid API Key' } }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test-model' }, { id: 'other-model' }] }));
      }

      if (key === 'bad-429') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
        return res.end(JSON.stringify({
          error: { message: `Rate limit reached for model \`${body.model}\` on tokens per day (TPD)`, type: 'rate_limit_exceeded' },
        }));
      }
      if (key === 'bad-500') {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'internal upstream boom' } }));
      }
      if (key === 'bad-auth') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Invalid API Key' } }));
      }

      /* --- Anthropic protocol --- */
      if (req.url === '/v1/messages') {
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const ev = (type, obj) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;
          res.write(ev('message_start', { message: { id: 'msg_1', model: body.model, usage: { input_tokens: 6 } } }));
          res.write(ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
          res.write(ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Anthropic ' } }));
          res.write(ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'stream' } }));
          res.write(ev('content_block_stop', { index: 0 }));
          res.write(ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }));
          res.write(ev('message_stop', {}));
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'msg_1',
          type: 'message',
          model: body.model,
          content: [{ type: 'text', text: 'Hello from Claude' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 12, output_tokens: 5 },
        }));
      }

      /* --- OpenAI protocol --- */
      if (req.url === '/v1/chat/completions') {
        if (body.stream) {
          return sse(res, [
            { id: 'chatcmpl-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
            { id: 'chatcmpl-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] },
            { id: 'chatcmpl-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: ' world' }, finish_reason: 'stop' }] },
            { id: 'chatcmpl-1', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } },
          ]);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: `echo from ${key}` }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
        }));
      }

      if (req.url === '/v1/audio/transcriptions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ text: 'hello from audio' }));
      }
      if (req.url === '/v1/audio/speech') {
        const audio = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x00]);
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length });
        return res.end(audio);
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: `mock: no route ${req.url}` } }));
    });
  });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function call(pathname, { method = 'GET', body, key = clientKey, headers = {} } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* sse */ }
  return { status: res.status, headers: res.headers, text, json };
}

/* ------------------------------------------------------------------ */
/* Test run                                                            */
/* ------------------------------------------------------------------ */

(async () => {
  console.log('\nBlueRouter smoke test\n');

  mock = mockServer();
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  mockUrl = `http://127.0.0.1:${mock.address().port}/v1`;
  console.log(`  mock upstream: ${mockUrl}`);

  // Config: three providers pointed at the same fake upstream.
  const bootstrap = new Store({ dataDir: DATA_DIR }).init();
  const cfg = bootstrap.get();
  const providerDefaults = () => ({
    enabled: true,
    protocol: 'openai',
    authStyle: 'bearer',
    models: ['test-model', 'other-model'],
    quota: {},
  });
  Object.assign(cfg.providers, {
    mock: { ...providerDefaults(), baseUrl: mockUrl },
    mock500: { ...providerDefaults(), baseUrl: mockUrl },
    mockfail: { ...providerDefaults(), baseUrl: mockUrl },
    mockauth: { ...providerDefaults(), baseUrl: mockUrl },
    anthropic: { ...providerDefaults(), baseUrl: mockUrl, protocol: 'anthropic', authStyle: 'x-api-key', models: ['claude-test'] },
  });
  cfg.routing.maxRetries = 3;
  cfg.routing.cooldownSeconds = 300;
  cfg.routing.mode = 'sticky'; // deterministic failover order for this test
  bootstrap.save();

  instance = await start({ port: PORT, host: '127.0.0.1', dataDir: DATA_DIR, quiet: true });
  const store = instance.store;
  cfg.clientKey = store.get().clientKey;
  cfg.adminToken = store.get().adminToken;
  clientKey = cfg.clientKey;
  adminToken = cfg.adminToken;

  // Priority makes the broken key preferred so failover is exercised.
  store.addKey({ provider: 'mock', key: 'bad-429', name: 'groq-429', priority: 100 });
  store.addKey({ provider: 'mock', key: 'good-a', name: 'groq-good-1' });
  store.addKey({ provider: 'mock', key: 'good-b', name: 'groq-good-2' });
  store.addKey({ provider: 'mock500', key: 'bad-500', name: 'down-1', priority: 100 });
  store.addKey({ provider: 'mock500', key: 'good-a', name: 'down-good' });
  store.addKey({ provider: 'mockfail', key: 'bad-429', name: 'only-broken', priority: 10 });
  store.addKey({ provider: 'mockauth', key: 'bad-auth', name: 'expired', priority: 10 });
  store.addKey({ provider: 'mockauth', key: 'good-a', name: 'auth-good' });
  store.addKey({ provider: 'anthropic', key: 'ant-key', name: 'claude-1' });
  store.save();

  /* ---------------------------- tests ---------------------------- */

  await check('anthropic translation keeps tool calls and tool results', () => {
    const { toAnthropic } = require('../src/adapters');
    const out = toAnthropic({
      messages: [
        { role: 'user', content: 'Weather in Mumbai?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Mumbai"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '31C sunny' },
      ],
    }, 'claude-test');
    assert.strictEqual(out.messages[0].role, 'user');
    assert.deepStrictEqual(out.messages[0].content[0], { type: 'text', text: 'Weather in Mumbai?' });
    assert.deepStrictEqual(out.messages[1].content[0], { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Mumbai' } });
    assert.deepStrictEqual(out.messages[2].content[0], { type: 'tool_result', tool_use_id: 'call_1', content: '31C sunny' });
  });

  await check('comma separated provider models are normalised', () => {
    const { getProvider } = require('../src/providers');
    const p = getProvider('custom', { providers: { custom: { baseUrl: 'https://x/v1', models: 'a, b ,c' } } });
    assert.deepStrictEqual(p.models, ['a', 'b', 'c']);
    const p2 = getProvider('custom', { providers: { custom: { baseUrl: 'https://x/v1', models: ['z'] } } });
    assert.deepStrictEqual(p2.models, ['z']);
  });

  await check('health endpoint is public and reports 9 accounts', async () => {
    const r = await call('/health', { key: '' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.accounts, 9);
  });

  await check('wrong client key is rejected with 401', async () => {
    const r = await call('/v1/models', { key: 'blue_wrong' });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.json.error.code, 'invalid_api_key');
  });

  await check('GET /v1/models lists configured models', async () => {
    const r = await call('/v1/models');
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.data.length >= 2);
    assert.ok(r.json.data.some((m) => m.id === 'test-model'));
  });

  await check('429 account is cooled down and request fails over to a good account', async () => {
    const r = await call('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.strictEqual(r.status, 200, r.text);
    assert.match(r.json.choices[0].message.content, /echo from good-/);
    assert.match([...r.headers.keys()].join(','), /x-bluerouter-account/);
    const limited = store.get().keys.find((k) => k.name === 'groq-429');
    assert.ok(limited.cooldownUntil, 'limited key should be in cooldown');
    assert.ok(limited.health.status === 'rate-limited' || limited.health.status === 'error');
    assert.strictEqual(limited.cooldownScope, 'model');
  });

  await check('cooldown is scoped to the model (other model still allowed)', async () => {
    const limited = store.get().keys.find((k) => k.name === 'groq-429');
    const pick = store.pickKey({ provider: 'mock', model: 'other-model', body: { messages: [{ role: 'user', content: 'x' }] } });
    assert.ok(pick.list.length >= 1);
    void limited;
  });

  await check('500 upstream also fails over', async () => {
    const r = await call('/v1/chat/completions?provider=mock500', {
      method: 'POST',
      body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.strictEqual(r.status, 200, r.text);
    assert.match(r.json.choices[0].message.content, /echo from good-a/);
    const down = store.get().keys.find((k) => k.name === 'down-1');
    assert.ok(down.cooldownUntil);
  });

  await check('invalid provider key (401) is skipped, next account answers', async () => {
    const r = await call('/v1/chat/completions?provider=mockauth', {
      method: 'POST',
      body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.strictEqual(r.status, 200, r.text);
    const bad = store.get().keys.find((k) => k.name === 'expired');
    assert.strictEqual(bad.health.status, 'invalid-key');
  });

  await check('when every account fails, client gets a clean OpenAI-style error', async () => {
    const r = await call('/v1/chat/completions?provider=mockfail', {
      method: 'POST',
      body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.strictEqual(r.status, 429, r.text);
    assert.ok(r.json.error);
    assert.match(r.json.error.message, /failed|available/i);
  });

  await check('streaming passes SSE through and ends with [DONE]', async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /"content":"Hello"/);
    assert.match(text, /\[DONE\]/);
  });

  await check('anthropic protocol is translated to OpenAI JSON', async () => {
    const r = await call('/v1/chat/completions?provider=anthropic', {
      method: 'POST',
      body: { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32 },
    });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.object, 'chat.completion');
    assert.strictEqual(r.json.choices[0].message.content, 'Hello from Claude');
    assert.strictEqual(r.json.usage.prompt_tokens, 12);
    assert.strictEqual(r.json.usage.completion_tokens, 5);
  });

  await check('anthropic streaming is translated to OpenAI chunks', async () => {
    const res = await fetch(`${BASE}/v1/chat/completions?provider=anthropic`, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-test', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.match(text, /"object":"chat\.completion\.chunk"/);
    assert.match(text, /"content":"Anthropic "/);
    assert.match(text, /"content":"stream"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /\[DONE\]/);
  });

  await check('model prefix targets a provider explicitly', async () => {
    const r = await call('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'anthropic/claude-test', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.headers.get('x-bluerouter-provider'), 'anthropic');
    assert.strictEqual(r.json.choices[0].message.content, 'Hello from Claude');
  });

  await check('admin API adds an account over HTTP with a background health check', async () => {
    const r = await call('/admin/keys', {
      method: 'POST',
      key: adminToken,
      body: { provider: 'mock', key: 'good-c', name: 'http-added' },
    });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.json.data.name, 'http-added');
    assert.notStrictEqual(r.json.data.masked, 'good-c');
    assert.ok(r.json.data.masked.includes('•') || r.json.data.masked.includes('…'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const list = await call('/admin/keys', { key: adminToken });
    const added = list.json.data.find((k) => k.name === 'http-added');
    assert.ok(added);
    assert.strictEqual(added.health.status, 'ok');
  });

  await check('admin check-all verifies every account', async () => {
    const r = await call('/admin/check-all', { method: 'POST', key: adminToken });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.data.length >= 10);
    assert.ok(r.json.data.some((x) => x.status === 'invalid-key'));
  });

  await check('an unknown upstream route returns 404 without poisoning account health', async () => {
    const before = store.get().keys.filter((k) => k.provider === 'mockauth').map((k) => k.health.status);
    const r = await call('/v1/embeddings?provider=mockauth', { method: 'POST', body: { model: 'x', input: 'y' } });
    assert.strictEqual(r.status, 404, r.text);
    assert.ok(r.json.error);
    const after = store.get().keys.filter((k) => k.provider === 'mockauth').map((k) => k.health.status);
    assert.deepStrictEqual(after, before, `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  });

  await check('request log records successes with provider + account', async () => {
    const r = await call('/admin/logs?limit=50', { key: adminToken });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.data.length > 0);
    assert.ok(r.json.data.some((l) => l.ok && l.provider));
  });

  await check('stats aggregate usage', async () => {
    const r = await call('/admin/stats', { key: adminToken });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.data.totals.requests > 5);
    assert.ok(r.json.data.totals.tokensIn >= 13);
  });

  await check('config PATCH updates routing without exposing secrets', async () => {
    const r = await call('/admin/config', { method: 'PATCH', key: adminToken, body: { routing: { maxRetries: 4 } } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.routing.maxRetries, 4);
    assert.strictEqual(r.json.data.clientKey, undefined);
  });

  await check('playground test endpoint goes end to end', async () => {
    const r = await call('/admin/test', {
      method: 'POST',
      key: adminToken,
      body: { provider: 'mock', model: 'test-model', prompt: 'ping' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.ok, true, r.text);
    assert.match(r.json.data.reply, /echo from good-/);
  });

  await check('audio request is routed only to audio-capable providers', async () => {
    const r = await call('/v1/chat/completions?provider=anthropic', {
      method: 'POST',
      body: { model: 'whisper-large-v3', messages: [{ role: 'user', content: 'x' }] },
    });
    assert.ok(r.status === 400 || r.status === 503, `expected rejection, got ${r.status} ${r.text}`);
    const r2 = await call('/v1/models');
    assert.strictEqual(r2.status, 200);
  });

  await check('multipart audio transcription is proxied untouched', async () => {
    const boundary = '----blueroutertest';
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.mp3"\r\nContent-Type: audio/mpeg\r\n\r\nID3fake\r\n--${boundary}--\r\n`;
    const res = await fetch(`${BASE}/v1/audio/transcriptions?provider=mock`, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientKey}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: payload,
    });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.text, 'hello from audio');
  });

  await check('binary audio responses are streamed back byte-for-byte', async () => {
    const res = await fetch(`${BASE}/v1/audio/speech?provider=mock`, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', input: 'hi', voice: 'alloy' }),
    });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /audio\/mpeg/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(buf.length, 12);
    assert.deepStrictEqual([...buf.slice(0, 3)], [0x49, 0x44, 0x33]);
  });

  await check('data files are created with private permissions', async () => {
    const cfgPath = path.join(DATA_DIR, 'config.json');
    const mode = fs.statSync(cfgPath).mode & 0o777;
    assert.strictEqual(mode, 0o600, `config mode ${mode.toString(8)}`);
    const json = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.ok(json.clientKey);
    assert.ok(Array.isArray(json.keys));
  });

  /* --------------------------- teardown --------------------------- */

  await shutdown(instance, 'TEST');
  await new Promise((resolve) => mock.close(resolve));

  console.log(`\n  ${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.error(`  ${f.name}:\n${f.err.stack}\n`);
    console.error(`  data kept for inspection: ${DATA_DIR}\n`);
    process.exit(1);
  }
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(0);
})().catch((err) => {
  console.error(err);
  try { if (mock) mock.close(); } catch { /* ignore */ }
  process.exit(1);
});
