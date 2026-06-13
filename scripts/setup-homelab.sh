#!/usr/bin/env bash
# =============================================================================
# TEZA Homelab Setup Script
# Run this ONCE on your Ubuntu/Debian homelab server to get everything ready.
# After this script completes, every push to main on GitHub will auto-deploy.
# =============================================================================
set -euo pipefail

REPO_URL="https://github.com/C-o-m-o-n/teza.git"
DEPLOY_DIR="$HOME/teza"
RUNNER_DIR="$HOME/actions-runner"
NODE_MAJOR=20   # LTS

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  TEZA Homelab Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. System dependencies ──────────────────────────────────────────────────
echo ""
echo "▶ [1/6] Installing system dependencies..."
sudo apt-get update -q
sudo apt-get install -y curl git build-essential

# ── 2. Node.js via NodeSource ───────────────────────────────────────────────
echo ""
echo "▶ [2/6] Installing Node.js $NODE_MAJOR LTS..."
if ! node --version 2>/dev/null | grep -q "^v$NODE_MAJOR"; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node --version
npm --version

# ── 3. pnpm & PM2 ──────────────────────────────────────────────────────────
echo ""
echo "▶ [3/6] Installing pnpm and PM2..."
npm install -g pnpm pm2

# Enable PM2 to start on system boot
pm2 startup --no-daemon 2>&1 | grep "sudo" | bash || true
echo "PM2 startup configured."

# ── 4. Clone / update repo ─────────────────────────────────────────────────
echo ""
echo "▶ [4/6] Setting up repo at $DEPLOY_DIR..."
if [ -d "$DEPLOY_DIR/.git" ]; then
  echo "  Repo already exists — pulling latest..."
  git -C "$DEPLOY_DIR" fetch origin
  git -C "$DEPLOY_DIR" reset --hard origin/main
else
  git clone "$REPO_URL" "$DEPLOY_DIR"
fi

cd "$DEPLOY_DIR"
pnpm install --prod --frozen-lockfile
mkdir -p logs data/replays

# Initialise players.json if it doesn't exist (fresh server)
if [ ! -f data/players.json ]; then
  echo "{}" > data/players.json
  echo "  Created empty data/players.json"
fi

# ── 5. Start TEZA under PM2 ────────────────────────────────────────────────
echo ""
echo "▶ [5/6] Starting TEZA with PM2..."
pm2 delete teza 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

echo ""
echo "  Health check..."
sleep 3
curl --silent --fail http://localhost:3000 > /dev/null \
  && echo "  ✅ TEZA is running on port 3000" \
  || echo "  ⚠️  Server not responding yet — check: pm2 logs teza"

# ── 6. GitHub Actions self-hosted runner ───────────────────────────────────
echo ""
echo "▶ [6/6] Setting up GitHub Actions self-hosted runner..."
echo ""
echo "  ┌─────────────────────────────────────────────────────────┐"
echo "  │  You need a runner registration token from GitHub.      │"
echo "  │                                                         │"
echo "  │  1. Go to:                                              │"
echo "  │     https://github.com/C-o-m-o-n/teza/settings/        │"
echo "  │          actions/runners/new                            │"
echo "  │                                                         │"
echo "  │  2. Select: Linux / x64                                 │"
echo "  │  3. Copy the token shown on that page (starts with AQ…) │"
echo "  │  4. Paste it below when prompted.                       │"
echo "  └─────────────────────────────────────────────────────────┘"
echo ""

read -rp "  Paste your runner token here: " RUNNER_TOKEN

mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"

# Download latest runner release
RUNNER_VERSION=$(curl -s https://api.github.com/repos/actions/runner/releases/latest \
  | grep '"tag_name"' | sed 's/.*"v\([^"]*\)".*/\1/')
RUNNER_ARCHIVE="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"

if [ ! -f "$RUNNER_ARCHIVE" ]; then
  echo "  Downloading GitHub Actions runner v${RUNNER_VERSION}..."
  curl -fsSL \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${RUNNER_ARCHIVE}" \
    -o "$RUNNER_ARCHIVE"
  tar xzf "$RUNNER_ARCHIVE"
fi

# Configure the runner
./config.sh \
  --url "https://github.com/C-o-m-o-n/teza" \
  --token "$RUNNER_TOKEN" \
  --name "$(hostname)-homelab" \
  --labels "self-hosted,homelab,Linux,X64" \
  --work "$HOME/_work" \
  --unattended \
  --replace

# Install as a systemd service (runs as current user)
sudo ./svc.sh install
sudo ./svc.sh start

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Setup complete!"
echo ""
echo "  TEZA server : http://localhost:3000  (via PM2)"
echo "  PM2 status  : pm2 status"
echo "  PM2 logs    : pm2 logs teza"
echo "  Runner svc  : sudo systemctl status actions.runner.*"
echo ""
echo "  Now configure Cloudflare Tunnel → localhost:3000"
echo "  to expose https://teza.comonhq.com"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
