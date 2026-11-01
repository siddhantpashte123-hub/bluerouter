'use strict';

/**
 * Service lifecycle test — background mode (no systemd).
 *
 * Covers exactly what a Codespace / Docker / WSL user does:
 *   install --background -> status -> logs -> stop -> start -> uninstall
 *
 * Run: npm run test:service
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'blue');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bluerouter-svc-'));
const PORT = Number(process.env.TEST_PORT || 12143);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];

function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], {
      env: { ...process.env, BLUEROUTER_DATA: DATA, NO_COLOR: '1', ...env },
      encoding: 'utf8',
      timeout: 90000,
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

const health = () => fetch(`${BASE}/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null);

(async () => {
  console.log('\nBlueRouter service (background mode) test\n');

  if (await health()) {
    console.error(`  port ${PORT} is already in use — stop the other BlueRouter first.`);
    process.exit(1);
  }

  await check('install --background starts a detached server', async () => {
    const r = await run(['install', '--background', '--port', String(PORT)]);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /BlueRouter is running/);
    assert.match(r.out, /background process/);
    assert.match(r.out, /Background mode:/);
    const json = await health();
    assert.ok(json, 'server is not answering /health');
    assert.strictEqual(json.port, PORT);
  });

  await check('install records the mode so status survives restarts', async () => {
    const record = JSON.parse(fs.readFileSync(path.join(DATA, 'service.json'), 'utf8'));
    assert.strictEqual(record.mode, 'background');
    assert.strictEqual(record.port, PORT);
    const runFile = JSON.parse(fs.readFileSync(path.join(DATA, 'run.json'), 'utf8'));
    assert.ok(Number.isInteger(runFile.pid));
    assert.strictEqual(runFile.pid > 0, true);
  });

  await check('status reports a running background service with a pid', async () => {
    const r = await run(['status', '--json']);
    assert.strictEqual(r.code, 0, r.out);
    const json = JSON.parse(r.stdout);
    assert.strictEqual(json.service.mode, 'background');
    assert.strictEqual(json.service.installed, true);
    assert.strictEqual(json.service.active, true);
    assert.ok(json.service.pid > 0);
  });

  await check('logs are written to data/logs/bluerouter.log and shown by blue logs', async () => {
    const file = path.join(DATA, 'logs', 'bluerouter.log');
    assert.ok(fs.existsSync(file), 'log file missing');
    assert.match(fs.readFileSync(file, 'utf8'), /One API for all your AI accounts|Dashboard/);
    const r = await run(['logs', '--lines', '40']);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /Service log/);
    assert.match(r.out, /bluerouter\.log/);
  });

  await check('installing again reuses the running process', async () => {
    const before = JSON.parse(fs.readFileSync(path.join(DATA, 'run.json'), 'utf8')).pid;
    const r = await run(['install', '--background', '--port', String(PORT)]);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /Already running/);
    const after = JSON.parse(fs.readFileSync(path.join(DATA, 'run.json'), 'utf8')).pid;
    assert.strictEqual(after, before);
  });

  await check('api works through the background service', async () => {
    const token = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8')).clientKey;
    const res = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${token}` } });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.object, 'list');
  });

  await check('stop kills the process and keeps it installed', async () => {
    const pid = JSON.parse(fs.readFileSync(path.join(DATA, 'run.json'), 'utf8')).pid;
    const r = await run(['stop']);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /Service stopped/);
    assert.strictEqual(await health(), null);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.strictEqual(alive, false, 'process is still alive');
    assert.ok(!fs.existsSync(path.join(DATA, 'run.json')), 'run.json should be removed');
    assert.ok(fs.existsSync(path.join(DATA, 'service.json')), 'service.json should stay');
    const st = JSON.parse((await run(['status', '--json'])).stdout);
    assert.strictEqual(st.service.installed, true);
    assert.strictEqual(st.service.active, false);
  });

  await check('start brings it back without blocking the terminal', async () => {
    const r = await run(['start']);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /Service started/);
    const json = await health();
    assert.ok(json, 'server did not come back');
  });

  await check('restart replaces the process', async () => {
    const pid = JSON.parse(fs.readFileSync(path.join(DATA, 'run.json'), 'utf8')).pid;
    const r = await run(['restart']);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /Service restarted/);
    const newPid = JSON.parse(fs.readFileSync(path.join(DATA, 'run.json'), 'utf8')).pid;
    assert.notStrictEqual(newPid, pid);
    assert.ok(await health());
  });

  await check('enable/disable explain that background mode has no boot start', async () => {
    const r = await run(['enable']);
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /no boot auto-start/i);
    const r2 = await run(['disable']);
    assert.strictEqual(r2.code, 1);
    assert.match(r2.out, /no boot auto-start/i);
  });

  await check('a busy port fails loudly instead of pretending to run', async () => {
    const otherData = fs.mkdtempSync(path.join(os.tmpdir(), 'bluerouter-svc-busy-'));
    const r = await run(['install', '--background', '--port', String(PORT)], { BLUEROUTER_DATA: otherData });
    assert.notStrictEqual(r.code, 0, r.out);
    assert.match(r.out, /already in use/i);
    assert.ok(!fs.existsSync(path.join(otherData, 'run.json')), 'no stale run.json');
    assert.ok(!fs.existsSync(path.join(otherData, 'service.json')), 'no stale service.json');
    fs.rmSync(otherData, { recursive: true, force: true });
  });

  await check('uninstall stops the process and removes the service record', async () => {
    const r = await run(['uninstall', '--yes']);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /Stopped (background )?process|No background process was running/);
    assert.ok(!fs.existsSync(path.join(DATA, 'service.json')));
    assert.strictEqual(await health(), null);
    const st = JSON.parse((await run(['status', '--json'])).stdout);
    assert.strictEqual(st.service.installed, false);
    assert.match(r.out, /accounts are still in/);
  });

  await check('a second install on a fresh data dir reports background mode', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'bluerouter-svc-mode-'));
    const r = await run(['install', '--background', '--port', String(PORT + 1)], { BLUEROUTER_DATA: other });
    assert.strictEqual(r.code, 0, r.out);
    const st = JSON.parse((await run(['status', '--json'], { BLUEROUTER_DATA: other })).stdout);
    assert.strictEqual(st.service.mode, 'background');
    assert.strictEqual(st.service.active, true);
    const stop = await run(['uninstall', '--yes', '--purge'], { BLUEROUTER_DATA: other });
    assert.strictEqual(stop.code, 0, stop.out);
    assert.ok(!fs.existsSync(other));
  });

  await check('accounts survive uninstall (data kept)', async () => {
    assert.ok(fs.existsSync(path.join(DATA, 'config.json')));
  });

  await check('--purge deletes the data directory', async () => {
    const r = await run(['uninstall', '--purge', '--yes']);
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(!fs.existsSync(DATA), 'data dir should be gone');
  });

  console.log(`\n  ${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.error(`  ${f.name}:\n${f.err.stack}\n`);
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
