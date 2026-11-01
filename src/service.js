'use strict';

/**
 * systemd integration — install / remove / inspect the BlueRouter service.
 * Only used by the `blue install`, `blue uninstall` and service commands.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

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
};
