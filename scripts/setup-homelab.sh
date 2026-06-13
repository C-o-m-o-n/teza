#!/usr/bin/env bash
# =============================================================================
# TEZA Homelab Setup Script
# Run this ONCE on your Ubuntu/Debian homelab server (as root).
# Installs Node.js, PM2, starts TEZA, and registers a GitHub Actions
# self-hosted runner — uses ZERO GitHub Actions cloud minutes.
# =============================================================================
set -euo pipefail

REPO_URL="https://github.com/C-o-m-o-n/teza.git"
DEPLOY_DIR="/root/teza"
RUNNER_DIR="/root/actions-runner"
NODE_MAJOR=20

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  TEZA Homelab Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. System dependencies ──────────────────────────────────────────────────
echo ""
echo "▶ [1/5] Installing system dependencies..."
apt-get update -q
apt-get install -y curl git build-essential

# ── 2. Node.js via NodeSource ───────────────────────────────────────────────
echo ""
echo "▶ [2/5] Installing Node.js $NODE_MAJOR LTS..."
if ! node --version 2>/dev/null | grep -q "^v$NODE_MAJOR"; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -
  apt-get install -y nodejs
fi
node --version

npm install -g pnpm pm2
pm2 startup systemd -u root --hp /root 2>&1 | tail -1 | bash || true

# ── 3. Clone repo & start TEZA ─────────────────────────────────────────────
echo ""
echo "▶ [3/5] Setting up TEZA at $DEPLOY_DIR..."
if [ -d "$DEPLOY_DIR/.git" ]; then
  git -C "$DEPLOY_DIR" fetch origin main
  git -C "$DEPLOY_DIR" reset --hard origin/main
else
  git clone --depth 1 "$REPO_URL" "$DEPLOY_DIR"
fi

cd "$DEPLOY_DIR"
pnpm install --prod --frozen-lockfile
mkdir -p logs data/replays

if [ ! -f data/players.json ]; then
  echo "{}" > data/players.json
fi

pm2 delete teza 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

sleep 3
curl --silent --fail http://localhost:3000 > /dev/null \
  && echo "  ✅ TEZA running on port 3000" \
  || echo "  ⚠️  Not responding yet — check: pm2 logs teza"

# ── 4. GitHub Actions self-hosted runner ───────────────────────────────────
echo ""
echo "▶ [4/5] Setting up GitHub Actions self-hosted runner..."
echo ""
echo "  Get a token from:"
echo "  https://github.com/C-o-m-o-n/teza/settings/actions/runners/new"
echo "  (select Linux / x64, copy the token shown)"
echo ""
read -rp "  Paste your runner token: " RUNNER_TOKEN

mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"

RUNNER_VERSION=$(curl -s https://api.github.com/repos/actions/runner/releases/latest \
  | grep '"tag_name"' | sed 's/.*"v\([^"]*\)".*/\1/')
ARCHIVE="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"

if [ ! -f "$ARCHIVE" ]; then
  echo "  Downloading runner v${RUNNER_VERSION}..."
  curl -fsSL \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${ARCHIVE}" \
    -o "$ARCHIVE"
  tar xzf "$ARCHIVE"
fi

RUNNER_ALLOW_RUNASROOT=1 ./config.sh \
  --url "https://github.com/C-o-m-o-n/teza" \
  --token "$RUNNER_TOKEN" \
  --name "$(hostname)-homelab" \
  --labels "self-hosted,homelab,Linux,X64" \
  --work "/root/_work" \
  --unattended \
  --replace

RUNNER_ALLOW_RUNASROOT=1 ./svc.sh install root
RUNNER_ALLOW_RUNASROOT=1 ./svc.sh start

echo ""
echo "▶ [5/5] Verifying runner..."
sleep 2
./svc.sh status

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Setup complete!"
echo ""
echo "  TEZA server  : http://localhost:3000  (PM2)"
echo "  Runner       : registered as '$(hostname)-homelab'"
echo ""
echo "  GitHub Actions uses ZERO cloud minutes — runs on this machine."
echo "  Push to main → watch Actions tab go green 🟢"
echo ""
echo "  Useful commands:"
echo "    pm2 status            ← server health"
echo "    pm2 logs teza         ← live logs"
echo "    ./svc.sh status       ← runner service (from $RUNNER_DIR)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
