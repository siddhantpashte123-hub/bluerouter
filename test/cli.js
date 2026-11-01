'use strict';

/**
 * CLI test — drives the real `blue` binary against a fake provider.
 * Offline commands (add/keys/check/config) and live commands that talk to a
 * running server (test/stats/requests/models/rm) are both covered.
 *
 * Run: npm run test:cli
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'blue');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bluerouter-cli-'));
const PORT = Number(process.env.TEST_PORT || 12142);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];

/** Async on purpose: the fake upstream lives in this process, so blocking
 *  with spawnSync would deadlock the requests the child makes to it. */
function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], {
      env: { ...process.env, BLUEROUTER_DATA: DATA, NO_COLOR: '1', BLUEROUTER_OFFLINE: '' },
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: stdout || '', out: `${stdout || ''}${stderr || ''}` });
    });
  });
}

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  \x1b[31m✖\x1b[0m ${name}\n      ${err.message}`);
  }
}

function mockServer() {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* ignore */ }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test-model' }, { id: 'other-model' }] }));
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'pong from cli test' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
        }));
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"error":{"message":"nope"}}');
    });
  });
}

(async () => {
  console.log('\nBlueRouter CLI test\n');

  const mock = mockServer();
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockUrl = `http://127.0.0.1:${mock.address().port}/v1`;

  await check('help lists install / uninstall / status', async () => {
    const r = await run(['help']);
    assert.strictEqual(r.code, 0);
    assert.match(r.out, /install/);
    assert.match(r.out, /uninstall/);
    assert.match(r.out, /status/);
    assert.match(r.out, /blue add groq/);
  });

  await check('install --systemd refuses when systemd is unusable / no root', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root: nothing to refuse
    const r = await run(['install', '--systemd', '--port', String(PORT)]);
    assert.strictEqual(r.code, 1, r.out);
    // either "systemd is not running" (no usable systemd) or "needs root"
    assert.match(r.out, /systemd is not running|sudo blue install/i);
  });

  await check('install --systemd explains when systemd is missing', async () => {
    const { systemdAvailable } = require('../src/service');
    if (systemdAvailable()) return; // machine has systemd, nothing to check
    const r = await run(['install', '--systemd', '--port', String(PORT)]);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /systemd is not running/i);
    assert.match(r.out, /--background/);
  });

  await check('status works before anything is configured', async () => {
    const r = await run(['status']);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /BlueRouter/);
    assert.match(r.out, /No accounts yet/);
  });

  await check('config set points a provider at the fake API', async () => {
    const r1 = await run(['config', 'set', 'port', String(PORT)]);
    assert.strictEqual(r1.code, 0, r1.out);
    const r2 = await run(['config', 'set', 'providers.custom.baseUrl', mockUrl]);
    assert.strictEqual(r2.code, 0, r2.out);
    const cfg = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));
    assert.strictEqual(cfg.port, PORT);
    assert.strictEqual(cfg.providers.custom.baseUrl, mockUrl);
  });

  await check('add registers two keys offline', async () => {
    const r = await run(['add', 'custom', 'key-one', 'key-two', '--name', 'demo']);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /2 account\(s\) registered/);
    const cfg = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));
    assert.strictEqual(cfg.keys.length, 2);
    assert.strictEqual(cfg.keys[0].name, 'demo-1');
    assert.ok(cfg.keys[0].id.startsWith('acc_'));
    assert.ok(!r.out.includes(cfg.keys[0].key), 'full keys must never be printed');
  });

  await check('add rejects duplicate keys and unknown providers', async () => {
    const r = await run(['add', 'custom', 'key-one']);
    assert.match(r.out, /already added|0 account/);
    const r2 = await run(['add', 'not-a-provider', 'abc']);
    assert.strictEqual(r2.code, 1);
    assert.match(r2.out, /Unknown provider/);
  });

  await check('keys lists accounts with masked keys', async () => {
    const r = await run(['keys']);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /demo-1/);
    assert.match(r.out, /demo-2/);
    assert.match(r.out, /custom/);
    assert.match(r.out, /•|…/);
  });

  await check('check calls the provider and reports working keys', async () => {
    const r = await run(['check']);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /working/);
    assert.match(r.out, /2 checked/);
  });

  await check('providers shows the catalog and quota info', async () => {
    const r = await run(['providers']);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /groq/i);
    assert.match(r.out, /cerebras/i);
    assert.match(r.out, /custom/i);
  });

  await check('url prints endpoints and the client key', async () => {
    const r = await run(['url']);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /\/v1/);
    assert.match(r.out, /blue_/);
    assert.match(r.out, /curl/);
  });

  /* ---------------------- start the live server ---------------------- */

  const busy = await fetch(`${BASE}/health`).then(() => true).catch(() => false);
  if (busy) {
    console.error(`  port ${PORT} is already in use — stop the other BlueRouter first.`);
    process.exit(1);
  }

  const server = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env: { ...process.env, BLUEROUTER_DATA: DATA, PORT: String(PORT) },
    stdio: 'ignore',
  });
  const serverExited = new Promise((resolve) => server.once('exit', resolve));
  let up = false;
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    up = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false);
    if (up) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 150));
  }

  try {
    assert.ok(up, 'server did not start');

    await check('status detects the running gateway', async () => {
      const r = await run(['status']);
      assert.strictEqual(r.code, 0, r.out);
      assert.match(r.out, /running/);
      assert.match(r.out, /2 enabled|2 accounts/);
    });

    await check('add works against the live API and persists', async () => {
      const r = await run(['add', 'custom', 'key-three']);
      assert.strictEqual(r.code, 0, r.out);
      assert.match(r.out, /1 account\(s\) registered/);
      assert.match(r.out, /Total for Custom.*3/);
      const all = (await run(['keys'])).out;
      assert.match(all, /custom: 3/);
    });

    await check('test sends a real request end-to-end', async () => {
      const r = await run(['test', '--provider', 'custom', '--model', 'test-model']);
      assert.strictEqual(r.code, 0, r.out);
      assert.match(r.out, /200 OK/);
      assert.match(r.out, /pong from cli test/);
      assert.match(r.out, /Latency/);
    });

    await check('stats reports traffic', async () => {
      const r = await run(['stats']);
      assert.strictEqual(r.code, 0, r.out);
      assert.match(r.out, /Requests/);
      assert.match(r.out, /Tokens/);
      assert.match(r.out, /custom/i);
    });

    await check('requests shows the request log', async () => {
      const r = await run(['requests', '--limit', '10']);
      assert.strictEqual(r.code, 0, r.out);
      assert.match(r.out, /test-model/);
      assert.match(r.out, /200/);
    });

    await check('models lists provider models live', async () => {
      const r = await run(['models']);
      assert.strictEqual(r.code, 0, r.out);
      assert.match(r.out, /test-model/);
    });

    await check('provider set updates settings and models stay a list', async () => {
      const r = await run(['provider', 'set', 'custom', 'models', 'test-model, other-model']);
      assert.strictEqual(r.code, 0, r.out);
      assert.match(r.out, /test-model, other-model/);
      const cfg = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));
      assert.deepStrictEqual(cfg.providers.custom.models, ['test-model', 'other-model']);
    });

    await check('test with no model auto-picks the provider default', async () => {
      const r = await run(['test']);
      assert.strictEqual(r.code, 0, r.out);
      assert.match(r.out, /200 OK/);
      assert.match(r.out, /Model\s+test-model/);
    });

    await check('rename, disable and enable an account', async () => {
      const keys = JSON.parse((await run(['status', '--json'])).stdout).accounts;
      const target = keys.find((k) => k.name === 'demo-1');
      assert.ok(target, `demo-1 not found in ${keys.map((k) => k.name).join(',')}`);
      assert.strictEqual((await run(['rename', target.id, 'renamed-acct'])).code, 0);
      assert.strictEqual((await run(['disable', target.id])).code, 0);
      let json = JSON.parse((await run(['status', '--json'])).stdout);
      assert.strictEqual(json.accounts.find((k) => k.id === target.id).enabled, false);
      assert.strictEqual((await run(['enable', target.id])).code, 0);
      json = JSON.parse((await run(['status', '--json'])).stdout);
      assert.strictEqual(json.accounts.find((k) => k.id === target.id).enabled, true);
      assert.strictEqual(json.accounts.find((k) => k.id === target.id).name, 'renamed-acct');
    });

    await check('rm removes an account', async () => {
      const keys = JSON.parse((await run(['status', '--json'])).stdout).accounts;
      const target = keys[keys.length - 1];
      const r = await run(['rm', target.id, '--yes']);
      assert.strictEqual(r.code, 0, r.out);
      assert.match(r.out, /Removed/);
      const after = JSON.parse((await run(['status', '--json'])).stdout).accounts;
      assert.strictEqual(after.length, keys.length - 1);
    });

    await check('rotate replaces the client key and invalidates the old one', async () => {
      const oldKey = JSON.parse((await run(['status', '--json'])).stdout).config.clientKey;
      const r = await run(['rotate']);
      assert.match(r.out, /blue_/);
      const newKey = (await run(['token'])).stdout.trim();
      assert.notStrictEqual(newKey, oldKey);
      const bad = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${oldKey}` } });
      assert.strictEqual(bad.status, 401);
      const good = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${newKey}` } });
      assert.strictEqual(good.status, 200);
    });

    await check('reset clears cooldowns', async () => {
      const r = await run(['reset']);
      assert.strictEqual(r.code, 0, r.out);
      assert.match(r.out, /cooldowns cleared/i);
    });

    await check('logs works for a service that is not installed', async () => {
      const r = await run(['logs']);
      assert.match(r.out, /not installed/i);
    });

    await check('stop / restart refuse politely when nothing is installed', async () => {
      const st = JSON.parse((await run(['status', '--json'])).stdout);
      if (st.service.installed) return; // another mode is installed here
      const stop = await run(['stop']);
      assert.strictEqual(stop.code, 1, stop.out);
      assert.match(stop.out, /not installed/i);
      const restart = await run(['restart']);
      assert.strictEqual(restart.code, 1, restart.out);
      assert.match(restart.out, /not installed/i);
    });

    await check('uninstall warns when nothing is installed', async () => {
      const st = JSON.parse((await run(['status', '--json'])).stdout);
      assert.strictEqual(st.service.installed, false);
      const r = await run(['uninstall', '--yes']);
      assert.strictEqual(r.code, 0, r.out);
      assert.match(r.out, /not installed/i);
    });
  } finally {
    server.kill('SIGTERM');
    const timeout = new Promise((r) => setTimeout(r, 4000));
    await Promise.race([serverExited, timeout]);
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGKILL');
      await Promise.race([serverExited, new Promise((r) => setTimeout(r, 1500))]);
    }
    mock.close();
  }

  console.log(`\n  ${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.error(`  ${f.name}:\n${f.err.stack}\n`);
    console.error(`  data kept: ${DATA}\n`);
    process.exit(1);
  }
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
