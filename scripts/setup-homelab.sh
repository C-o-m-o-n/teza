#!/usr/bin/env bash
# =============================================================================
# TEZA Homelab Setup Script
# Run this ONCE on your Ubuntu/Debian homelab server.
# After this, every push to main on GitHub deploys automatically via SSH.
# =============================================================================
set -euo pipefail

REPO_URL="https://github.com/C-o-m-o-n/teza.git"
DEPLOY_DIR="/root/teza"
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

# ── 3. pnpm & PM2 ──────────────────────────────────────────────────────────
echo ""
echo "▶ [3/5] Installing pnpm and PM2..."
npm install -g pnpm pm2

# Make PM2 survive reboots
pm2 startup systemd -u root --hp /root 2>&1 | tail -1 | bash || true
echo "PM2 startup configured."

# ── 4. Clone repo & start server ───────────────────────────────────────────
echo ""
echo "▶ [4/5] Cloning repo and starting TEZA..."
if [ -d "$DEPLOY_DIR/.git" ]; then
  echo "  Repo already exists — pulling latest..."
  cd "$DEPLOY_DIR"
  git fetch origin main
  git reset --hard origin/main
else
  git clone --depth 1 "$REPO_URL" "$DEPLOY_DIR"
  cd "$DEPLOY_DIR"
fi

pnpm install --prod --frozen-lockfile
mkdir -p logs data/replays

if [ ! -f data/players.json ]; then
  echo "{}" > data/players.json
  echo "  Created empty data/players.json"
fi

pm2 delete teza 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

# ── 5. Health check ─────────────────────────────────────────────────────────
echo ""
echo "▶ [5/5] Health check..."
sleep 3
curl --silent --fail http://localhost:3000 > /dev/null \
  && echo "  ✅ TEZA is running on port 3000" \
  || echo "  ⚠️  Server not responding yet — run: pm2 logs teza"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Setup complete!"
echo ""
echo "  Server running : http://localhost:3000  (PM2)"
echo "  PM2 status     : pm2 status"
echo "  PM2 logs       : pm2 logs teza"
echo ""
echo "  Next steps:"
echo "  1. In Cloudflare dashboard — create a Cloudflare Access SSH"
echo "     application for hostname: teza.comonhq.com → this server"
echo "  2. Add SSH_KEY secret to github.com/C-o-m-o-n/teza/settings/secrets"
echo "  3. Push to main — GitHub Actions will deploy automatically 🚀"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
