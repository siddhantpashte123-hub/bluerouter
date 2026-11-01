'use strict';

/**
 * Service management — install / remove / inspect the BlueRouter service.
 *
 * Two modes:
 *   systemd     best on a normal VPS: auto-restart, auto-start on boot, journald
 *   background  anywhere else (Docker, GitHub Codespaces, LXC, WSL, shared
 *               hosting without systemd): detached node process + PID file +
 *               log file. No root needed, but no boot-supervision either.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');

const UNIT_NAME = 'bluerouter';
const UNIT_PATH = `/etc/systemd/system/${UNIT_NAME}.service`;

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function systemdAvailable() {
  if (!fs.existsSync('/run/systemd/system')) return false;
  const found = spawnSync('sh', ['-c', 'command -v systemctl'], { encoding: 'utf8' });
  return found.status === 0;
}

function unitExists() {
  return fs.existsSync(UNIT_PATH);
}

function unitText({ repoDir, dataDir, nodeBin, port }) {
  return `[Unit]
Description=BlueRouter — one API for all AI accounts
Documentation=https://github.com/siddhantpashte123-hub/bluerouter
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${repoDir}
ExecStart=${nodeBin} ${path.join(repoDir, 'src', 'server.js')}
Environment=NODE_ENV=production
Environment="BLUEROUTER_DATA=${dataDir}"
Environment=PORT=${port}
Restart=always
RestartSec=3
TimeoutStopSec=15
KillSignal=SIGTERM
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=false
ReadWritePaths=${dataDir}

[Install]
WantedBy=multi-user.target
`;
}

function writeUnit(opts) {
  fs.mkdirSync(path.dirname(UNIT_PATH), { recursive: true });
  fs.writeFileSync(UNIT_PATH, unitText(opts), { mode: 0o644 });
  return UNIT_PATH;
}

function removeUnit() {
  if (fs.existsSync(UNIT_PATH)) fs.unlinkSync(UNIT_PATH);
  return UNIT_PATH;
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function systemctl(...args) {
  try {
    return { ok: true, out: run('systemctl', args) };
  } catch (err) {
    return {
      ok: false,
      out: (err.stdout || '').toString().trim(),
      err: (err.stderr || err.message || '').toString().trim(),
      code: err.status,
    };
  }
}

function daemonReload() {
  return systemctl('daemon-reload');
}

function status() {
  if (!unitExists()) return { installed: false, active: false, enabled: false };
  const activeRaw = systemctl('is-active', UNIT_NAME);
  const enabledRaw = systemctl('is-enabled', UNIT_NAME);
  const active = activeRaw.out === 'active';
  const enabled = enabledRaw.out === 'enabled';
  let pid = null;
  let since = null;
  if (active) {
    const props = systemctl('show', UNIT_NAME, '-p', 'MainPID', '-p', 'ActiveEnterTimestamp', '--value');
    const lines = (props.out || '').split('\n');
    pid = Number(lines[0]) || null;
    const ts = lines[1] ? Date.parse(lines[1]) : NaN;
    since = Number.isNaN(ts) ? null : ts;
  }
  return {
    installed: true,
    active,
    enabled,
    pid,
    since,
    state: activeRaw.out || 'unknown',
  };
}

function start() { return systemctl('start', UNIT_NAME); }
function stop() { return systemctl('stop', UNIT_NAME); }
function restart() { return systemctl('restart', UNIT_NAME); }
function enable() { return systemctl('enable', UNIT_NAME); }
function disable() { return systemctl('disable', UNIT_NAME); }

function journalLines(n = 60) {
  const res = systemctl('-u', UNIT_NAME, '-n', String(n), '--no-pager', '--output', 'cat');
  return res.out || res.err || '';
}

function followJournal() {
  const child = spawnSync('journalctl', ['-u', UNIT_NAME, '-f', '-n', '40'], { stdio: 'inherit' });
  return child.status;
}

/* ------------------------------------------------------------------ */
/* Background mode (no systemd)                                        */
/* ------------------------------------------------------------------ */

const RUN_FILE = 'run.json';          // pid of the running process (while running)
const INSTALL_FILE = 'service.json';  // remembers the installed mode (until uninstall)
const LOG_DIR = 'logs';
const LOG_FILE = 'bluerouter.log';

function runFile(dataDir) {
  return path.join(dataDir, RUN_FILE);
}

function installFile(dataDir) {
  return path.join(dataDir, INSTALL_FILE);
}

function readServiceRecord(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(installFile(dataDir), 'utf8'));
  } catch {
    return null;
  }
}

function writeServiceRecord(dataDir, record) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(installFile(dataDir), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return installFile(dataDir);
}

function removeServiceRecord(dataDir) {
  try {
    fs.unlinkSync(installFile(dataDir));
  } catch { /* already gone */ }
}

function logFile(dataDir) {
  return path.join(dataDir, LOG_DIR, LOG_FILE);
}

function readRun(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(runFile(dataDir), 'utf8'));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid || !Number.isInteger(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Is this pid a BlueRouter server? Guards against recycled pids. */
function looksLikeBlueRouter(pid) {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return /server\.js/.test(cmdline);
  } catch {
    return true; // /proc not available (macOS) — trust the pid file
  }
}

function backgroundStatus(dataDir) {
  const record = readServiceRecord(dataDir);
  const run = readRun(dataDir);
  if (!run || !pidAlive(run.pid) || !looksLikeBlueRouter(run.pid)) {
    return {
      mode: 'background',
      installed: !!record,
      active: false,
      enabled: false,
      pid: null,
      since: record && record.installedAt ? Date.parse(record.installedAt) : null,
      port: (record && record.port) || (run ? run.port : null),
      logPath: logFile(dataDir),
      state: record ? 'stopped' : 'not installed',
    };
  }
  return {
    mode: 'background',
    installed: true,
    active: true,
    enabled: false,
    pid: run.pid,
    since: run.startedAt ? Date.parse(run.startedAt) : null,
    port: run.port,
    logPath: logFile(dataDir),
    state: 'running',
  };
}

function backgroundStart({ repoDir, dataDir, nodeBin, port }) {
  const existing = backgroundStatus(dataDir);
  if (existing.active) {
    return { ok: true, already: true, pid: existing.pid };
  }
  fs.mkdirSync(path.join(dataDir, LOG_DIR), { recursive: true, mode: 0o700 });
  const log = logFile(dataDir);
  const fd = fs.openSync(log, 'a', 0o600);
  const child = spawn(nodeBin, [path.join(repoDir, 'src', 'server.js')], {
    cwd: repoDir,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      BLUEROUTER_DATA: dataDir,
      PORT: String(port),
    },
  });
  child.unref();
  fs.closeSync(fd);
  if (!readServiceRecord(dataDir)) {
    writeServiceRecord(dataDir, {
      mode: 'background',
      port,
      repoDir,
      nodeBin,
      dataDir,
      installedAt: new Date().toISOString(),
    });
  }
  const run = {
    mode: 'background',
    pid: child.pid,
    port,
    nodeBin,
    repoDir,
    dataDir,
    logPath: log,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(runFile(dataDir), `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
  return { ok: true, pid: child.pid, logPath: log };
}

function backgroundStop(dataDir, { quiet = false } = {}) {
  const run = readRun(dataDir);
  if (!run || !pidAlive(run.pid)) {
    try {
      fs.unlinkSync(runFile(dataDir));
    } catch { /* nothing to clean */ }
    return { ok: true, already: true };
  }
  const pid = Number(run.pid);
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if (err.code !== 'ESRCH') return { ok: false, err: err.message };
  }
  // wait up to ~6s for a clean exit
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (!pidAlive(pid) || !looksLikeBlueRouter(pid)) break;
    try {
      execFileSync('sleep', ['0.15'], { stdio: 'ignore' });
    } catch { /* ignore */ }
  }
  if (pidAlive(pid) && looksLikeBlueRouter(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch { /* already gone */ }
  }
  try {
    fs.unlinkSync(runFile(dataDir));
  } catch { /* ignore */ }
  if (!quiet) {
    // give the OS a moment to release the port
    try {
      execFileSync('sleep', ['0.2'], { stdio: 'ignore' });
    } catch { /* ignore */ }
  }
  return { ok: true, stopped: pid };
}

function backgroundLogs(dataDir, n = 60) {
  const file = logFile(dataDir);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n');
    return lines.slice(Math.max(0, lines.length - n - 1)).join('\n').replace(/\s+$/, '');
  } catch {
    return '';
  }
}

function followBackgroundLog(dataDir) {
  const file = logFile(dataDir);
  if (!fs.existsSync(file)) return 1;
  const child = spawnSync('tail', ['-f', '-n', '40', file], { stdio: 'inherit' });
  return child.status;
}

/* ------------------------------------------------------------------ */
/* Unified interface                                                   */
/* ------------------------------------------------------------------ */

/** 'systemd' | 'background' — what is installed on this machine for this data dir. */
function mode(dataDir) {
  if (unitExists()) return 'systemd';
  const record = readServiceRecord(dataDir);
  if (record && record.mode) return record.mode;
  return null;
}

/** One status object regardless of the mode. */
function statusOf(dataDir) {
  if (unitExists()) return { ...status(), mode: 'systemd', logPath: null };
  return backgroundStatus(dataDir);
}

/** Probe a local BlueRouter instance. */
async function probe(port, timeoutMs = 900) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
    const json = await res.json().catch(() => null);
    clearTimeout(timer);
    if (!res.ok || !json || json.status !== 'ok') return null;
    return json;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

module.exports = {
  UNIT_NAME,
  UNIT_PATH,
  isRoot,
  systemdAvailable,
  unitExists,
  unitText,
  writeUnit,
  removeUnit,
  systemctl,
  daemonReload,
  status,
  start,
  stop,
  restart,
  enable,
  disable,
  journalLines,
  followJournal,
  probe,
  run,
  // background mode
  RUN_FILE,
  INSTALL_FILE,
  runFile,
  installFile,
  logFile,
  readServiceRecord,
  writeServiceRecord,
  removeServiceRecord,
  readRun,
  pidAlive,
  backgroundStatus,
  backgroundStart,
  backgroundStop,
  backgroundLogs,
  followBackgroundLog,
  // unified
  mode,
  statusOf,
};
