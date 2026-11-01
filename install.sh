#!/usr/bin/env bash
#
# BlueRouter one-shot installer for a fresh VPS.
#
#   curl -fsSL https://raw.githubusercontent.com/siddhantpashte123-hub/bluerouter/main/install.sh | sudo bash
#
# Options:
#   --port <n>       port to listen on (default 1212)
#   --dir <path>     where to put the code (default /opt/bluerouter)
#   --branch <name>  git branch to install (default main)
#   --background     force background mode (no systemd needed)
#   --no-color       plain output
#
set -euo pipefail

REPO_URL="https://github.com/siddhantpashte123-hub/bluerouter.git"
PORT="1212"
TARGET_DIR="/opt/bluerouter"
BRANCH="main"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[90m'; N=$'\033[0m'
else
  B=""; G=""; Y=""; R=""; D=""; N=""
fi

say()  { printf "  %s\n" "$*"; }
ok()   { printf "  ${G}✔${N} %s\n" "$*"; }
warn() { printf "  ${Y}!${N} %s\n" "$*"; }
die()  { printf "\n  ${R}✖${N} %s\n\n" "$*"; exit 1; }
step() { printf "\n${B}  %s${N}\n" "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --port)   PORT="${2:?--port needs a value}"; shift 2 ;;
    --dir)    TARGET_DIR="${2:?--dir needs a value}"; shift 2 ;;
    --branch) BRANCH="${2:?--branch needs a value}"; shift 2 ;;
    --background) SERVICE_MODE="background"; shift ;;
    --no-color) B=""; G=""; Y=""; R=""; D=""; N=""; shift ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

printf "\n${B}  BlueRouter installer${N} ${D}— one API for all your AI accounts${N}\n"

# ------------------------------------------------------------------ root
if [ "$(id -u)" -ne 0 ]; then
  die "Run as root:  curl -fsSL <url>/install.sh | sudo bash"
fi

# ------------------------------------------------------------------ os
SERVICE_MODE="auto"
if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
  SERVICE_MODE="background"
  warn "systemd not available here (container / Codespace / WSL)."
  say  "→ installing as a background process instead (no auto-start on boot)."
fi

# ------------------------------------------------------------------ deps
step "1/4  System packages"
PKG=""
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null 2>&1 || true
  PKG="apt-get"
  apt-get install -y -qq ca-certificates curl git >/dev/null 2>&1 || true
elif command -v dnf >/dev/null 2>&1; then
  PKG="dnf"
  dnf install -y -q ca-certificates curl git >/dev/null 2>&1 || true
elif command -v yum >/dev/null 2>&1; then
  PKG="yum"
  yum install -y -q ca-certificates curl git >/dev/null 2>&1 || true
elif command -v apk >/dev/null 2>&1; then
  PKG="apk"
  apk add --no-cache ca-certificates curl git >/dev/null 2>&1 || true
else
  warn "Unknown package manager — assuming curl, git and node are installed."
fi
command -v git >/dev/null 2>&1 || die "git is required. Install it and re-run."
command -v curl >/dev/null 2>&1 || warn "curl not found (only needed for downloads)."
ok "base tools ready"

# ------------------------------------------------------------------ node
step "2/4  Node.js 18+"
node_major() {
  if command -v node >/dev/null 2>&1; then
    node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0
  else
    echo 0
  fi
}
MAJOR="$(node_major)"
if [ "${MAJOR:-0}" -ge 18 ]; then
  ok "node $(node -v) already installed"
else
  warn "Installing Node.js 20…"
  case "$PKG" in
    apt-get)
      apt-get install -y -qq nodejs >/dev/null 2>&1 || true
      if [ "$(node_major)" -lt 18 ]; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1 || die "Could not add the NodeSource repository."
        apt-get install -y -qq nodejs >/dev/null 2>&1 || die "Could not install Node.js."
      fi ;;
    dnf|yum)
      "$PKG" install -y -q nodejs >/dev/null 2>&1 || true ;;
    apk)
      apk add --no-cache nodejs npm >/dev/null 2>&1 || true ;;
    *)
      die "Install Node.js 18+ manually, then re-run this script." ;;
  esac
  [ "$(node_major)" -ge 18 ] || die "Node.js 18+ is required (found $(node -v 2>/dev/null || echo none))."
  ok "node $(node -v) installed"
fi

# ------------------------------------------------------------------ code
step "3/4  BlueRouter code"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ] && [ -f "$SCRIPT_DIR/src/server.js" ] \
   && [ -f "$SCRIPT_DIR/bin/blue" ] && grep -q '"name": "bluerouter"' "$SCRIPT_DIR/package.json"; then
  TARGET_DIR="$SCRIPT_DIR"
  ok "using this checkout: $TARGET_DIR"
elif [ -d "$TARGET_DIR/.git" ]; then
  git -C "$TARGET_DIR" fetch --quiet origin "$BRANCH"
  git -C "$TARGET_DIR" checkout --quiet "$BRANCH"
  git -C "$TARGET_DIR" pull --quiet --ff-only origin "$BRANCH"
  ok "updated $TARGET_DIR ($BRANCH)"
else
  mkdir -p "$(dirname "$TARGET_DIR")"
  git clone --quiet --branch "$BRANCH" --depth 1 "$REPO_URL" "$TARGET_DIR" \
    || die "git clone failed. Is the repository public / is the network up?"
  ok "cloned into $TARGET_DIR"
fi

# ------------------------------------------------------------------ install
step "4/4  Service"
cd "$TARGET_DIR"
chmod +x bin/blue
if [ "$SERVICE_MODE" = "background" ]; then
  node bin/blue install --background --port "$PORT"
else
  node bin/blue install --port "$PORT"
fi

printf "\n${G}  Done.${N} Next:  ${B}blue add groq <API_KEY>${N}  →  ${B}blue check${N}  →  ${B}blue test${N}\n\n"
