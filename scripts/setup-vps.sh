#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# VPS Setup Script — Solana Memecoin Trader
# Tested on Ubuntu 22.04 / Debian 12
# Run as root: bash setup-vps.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

echo "═══════════════════════════════════════════════"
echo " Solana Meme Trader — VPS Setup                "
echo "═══════════════════════════════════════════════"

# ── 1. System update ──────────────────────────────────────────────────────────
apt-get update -y && apt-get upgrade -y

# ── 2. Install Node.js 20 ─────────────────────────────────────────────────────
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs build-essential git curl

echo "Node version: $(node -v)"
echo "NPM  version: $(npm -v)"

# ── 3. Install PM2 (process manager for 24/7 uptime) ─────────────────────────
npm install -g pm2

# ── 4. Create dedicated user ─────────────────────────────────────────────────
if ! id "trader" &>/dev/null; then
  useradd -m -s /bin/bash trader
  echo "User 'trader' created"
fi

# ── 5. Clone repo (adjust URL to your fork/repo) ─────────────────────────────
# EDIT THIS LINE with your actual repository URL:
# su - trader -c "git clone https://github.com/YOUR_USER/solana-meme-trader ~/trader"

# ── 6. UFW firewall ───────────────────────────────────────────────────────────
apt-get install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
# API server only on localhost (extension connects locally via SSH tunnel if needed)
ufw --force enable

echo "Firewall configured (SSH only)"

# ── 7. Done ───────────────────────────────────────────────────────────────────
echo ""
echo "Setup complete! Next steps:"
echo "  1. cd backend"
echo "  2. cp .env.example .env && nano .env  (fill in your config)"
echo "  3. npm install"
echo "  4. pm2 start ecosystem.config.js"
echo "  5. pm2 save && pm2 startup"
