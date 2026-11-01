'use strict';

/**
 * Local demo — a fake provider + a seeded BlueRouter, so you can click around
 * the dashboard without any real API keys.
 *
 *   npm run demo        →  http://127.0.0.1:1212
 *
 * Everything in here is fake: the "provider" answers from memory, the keys are
 * random strings, and data lives in ./.demo (safe to delete).
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { Store } = require('../src/store');
const { start, shutdown } = require('../src/server');
const { lanIp } = require('../src/util');

const PORT = Number(process.env.PORT || 1212);
const DATA = path.join(__dirname, '..', '.demo');
const MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b'];

function mockProvider() {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* ignore */ }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: MODELS.map((id) => ({ id })) }));
      }
      if (req.url === '/v1/chat/completions') {
        const prompt = (body.messages || []).slice(-1)[0]?.content || '';
        const reply = `This is the BlueRouter demo answering "${String(prompt).slice(0, 60)}". Add your real keys with: blue add groq <API_KEY>`;
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const part of reply.match(/.{1,10}/g) || []) {
            res.write(`data: ${JSON.stringify({ id: 'demo', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: part } }] })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ id: 'demo', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 } })}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'demo',
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
        }));
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"error":{"message":"demo provider: no route"}}');
    });
  });
}

(async () => {
  if (fs.existsSync(path.join(DATA, 'config.json'))) {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  const store = new Store({ dataDir: DATA }).init();
  const mock = mockProvider();
  await new Promise((resolve) => mock.listen(Number(process.env.DEMO_MOCK_PORT || 0), '127.0.0.1', resolve));
  const mockPort = mock.address().port;

  const cfg = store.get();
  cfg.port = PORT;
  cfg.providers.custom = {
    enabled: true,
    baseUrl: `http://127.0.0.1:${mockPort}/v1`,
    protocol: 'openai',
    authStyle: 'bearer',
    models: MODELS,
    quota: { note: 'Fake provider — this is the BlueRouter demo' },
  };
  store.save();
  for (let i = 1; i <= 4; i += 1) {
    store.addKey({ provider: 'custom', key: `demo_key_${i}_${'x'.repeat(24)}`, name: `demo-groq-${i}` });
  }
  store.save();

  const instance = await start({ port: PORT, host: '0.0.0.0', dataDir: DATA, quiet: true });
  const { adminToken, clientKey } = instance.store.get();
  const base = `http://${lanIp()}:${PORT}`;

  console.log(`\n  \x1b[1mDEMO MODE\x1b[0m — fake provider, fake keys, fresh data every start.`);
  console.log(`  Dashboard : ${base}/#token=${adminToken}`);
  console.log(`  API base  : ${base}/v1`);
  console.log(`  API key   : ${clientKey}`);
  console.log(`  Admin     : ${adminToken}`);
  console.log(`  Data      : ${DATA}\n`);

  const stop = async (sig) => {
    await shutdown(instance, sig);
    mock.close();
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
