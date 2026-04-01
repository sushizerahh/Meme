# Solana Memecoin Trader

Automated Solana memecoin trading system with AI hype detection, multi-layer anti-scam filters, and a Chrome extension dashboard.

> **DISCLAIMER:** Trading cryptocurrencies involves substantial risk of loss. This software is provided for educational purposes. Only trade with capital you can afford to lose entirely. Never store your main wallet's private key in this system — use a dedicated hot wallet.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Chrome Extension                          │
│  popup.html ←→ popup.js ←→ background.js (WebSocket)        │
└──────────────────────────┬──────────────────────────────────┘
                           │ REST + WebSocket
┌──────────────────────────▼──────────────────────────────────┐
│                     Backend (Node.js)                        │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ Scanner  │  │  Scorer  │  │AntiScam  │  │  Social    │  │
│  │(Raydium  │  │(0-100pt  │  │(honeypot │  │(Twitter +  │  │
│  │ WS pool) │  │ system)  │  │ rugpull) │  │ Telegram)  │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬──────┘  │
│       └─────────────┴─────────────┴───────────────┘         │
│                         │                                    │
│                  ┌──────▼──────┐                             │
│                  │   Trader    │  ← Risk Manager             │
│                  │  (engine)   │  ← Copy Trader              │
│                  └──────┬──────┘                             │
│                         │                                    │
│              ┌──────────┴──────────┐                        │
│         ┌────▼────┐          ┌─────▼────┐                   │
│         │ Jupiter │          │ Raydium  │                   │
│         │  (swap) │          │ (pools)  │                   │
│         └─────────┘          └──────────┘                   │
│                                                              │
│  SQLite DB: tokens, positions, trades, social_signals        │
└─────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
Meme/
├── backend/
│   ├── src/
│   │   ├── config/config.js        # All configuration
│   │   ├── core/
│   │   │   ├── scanner.js          # New token detection (Raydium WS)
│   │   │   ├── scorer.js           # Token scoring system (0–100)
│   │   │   ├── trader.js           # Trading engine (buy/sell lifecycle)
│   │   │   ├── risk.js             # Risk management & position sizing
│   │   │   ├── copytrader.js       # Smart-money copy trading
│   │   │   └── backtest.js         # Historical performance analysis
│   │   ├── filters/
│   │   │   └── antiscam.js         # Honeypot/rug-pull detection
│   │   ├── social/
│   │   │   └── social.js           # Twitter + Telegram hype monitor
│   │   ├── dex/
│   │   │   ├── jupiter.js          # Jupiter v6 swaps
│   │   │   ├── raydium.js          # Raydium pool data
│   │   │   └── index.js            # Connection management
│   │   ├── database/db.js          # SQLite (better-sqlite3)
│   │   ├── api/server.js           # REST API + WebSocket server
│   │   ├── utils/
│   │   │   ├── logger.js           # Winston logger
│   │   │   └── encryption.js       # AES-256-GCM for sensitive data
│   │   └── index.js                # Main entry point
│   ├── package.json
│   ├── ecosystem.config.js         # PM2 config for VPS
│   └── .env.example
├── extension/
│   ├── manifest.json               # MV3 Chrome extension
│   ├── popup/
│   │   ├── popup.html              # Dashboard UI
│   │   ├── popup.css               # Dark theme styles
│   │   └── popup.js                # Dashboard logic
│   ├── background/
│   │   └── background.js           # WebSocket bridge + notifications
│   └── icons/                      # Add 16x16, 48x48, 128x128 icons
├── scripts/
│   └── setup-vps.sh                # One-click VPS setup
└── README.md
```

---

## Installation

### Prerequisites

- Node.js 18+ (`node -v`)
- npm 9+
- Chrome / Brave browser (for extension)

### 1. Clone and install

```bash
git clone <your-repo-url>
cd Meme/backend
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
nano .env   # or use any text editor
```

**Critical fields to fill in:**

| Variable | Description |
|----------|-------------|
| `WALLET_PRIVATE_KEY` | Base58 private key of your **dedicated trading wallet** |
| `RPC_ENDPOINTS` | Your private RPC URL(s) — Helius, QuickNode, etc. |
| `WS_ENDPOINT` | WebSocket RPC endpoint |
| `API_KEY` | Random secret to secure the local API |
| `TWITTER_BEARER_TOKEN` | Twitter v2 API Bearer Token (optional but recommended) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot for channel monitoring (optional) |

### 3. How to get a fast private RPC

Public RPCs (`api.mainnet-beta.solana.com`) are too slow for competitive sniping.

Recommended services (all have free tiers):
- **Helius** — helius.dev — best for Solana-specific data
- **QuickNode** — quicknode.com
- **Triton** — triton.one

Replace `RPC_ENDPOINTS` in `.env` with your private endpoint URL.

---

## Running the Bot

### Simulation mode (recommended first step)

```bash
npm run simulate
# or
SIMULATE=true npm start
```

No real transactions are executed. All logic runs with real on-chain data.

### Live trading

```bash
npm start
```

The API server starts at `http://127.0.0.1:3001`. Check logs in `./logs/`.

### Run backtest

```bash
npm run backtest
```

Analyzes all closed positions in the database and prints win rate, P&L, Sharpe ratio, and max drawdown.

---

## Chrome Extension Setup

### Install

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder

> **Icons:** Add PNG icons at `extension/icons/icon16.png`, `icon48.png`, `icon128.png`. Any 16×16, 48×48, 128×128 solid-color PNG will work for local use.

### Connect to backend

1. Click the extension icon → click ⚙ (Settings)
2. Set **API URL**: `http://127.0.0.1:3001`
3. Set **API Key**: the value of `API_KEY` in your `.env`
4. Click **Save & Connect**

The status indicator turns green when connected.

---

## Dashboard Guide

### Stats Bar

| Metric | Meaning |
|--------|---------|
| **Win Rate** | % of closed trades that were profitable |
| **Daily P&L** | Net SOL profit/loss for current day |
| **Total P&L** | All-time net SOL profit/loss |
| **Open** | Number of currently open positions |

### Positions Tab

Shows all open trades with:
- Symbol and entry size
- Current gain/loss %
- Remaining position % (after partial takes)
- Progress bar showing remaining allocation

### Tokens Tab

All tokens the scanner has seen, with:
- **Score** (0–100, color coded)
- Status: `watching` → `bought` → `sold/skipped`
- Liquidity at time of detection

### History Tab

All completed trades sorted by time. Use **Load more** to paginate.

### Hype Tab

- **Top Narratives**: keywords trending on Twitter/Telegram right now
- **Hype Alerts**: tokens that crossed the hype threshold (score ≥60)

### Emergency Stop

Immediately:
1. Halts all new buys
2. Closes all open positions at market
3. Pauses the engine until manually resumed

---

## Wallet Connection

The bot uses a **keypair loaded from your `.env` file** (`WALLET_PRIVATE_KEY`). Transactions are signed **locally in the Node.js process** — your private key never leaves your machine.

**Best practices:**
- Use a **dedicated hot wallet** funded with only your trading capital
- Never reuse your main wallet or a wallet holding NFTs/other assets
- Start with a small amount (0.5–2 SOL) until you validate the strategy
- The extension never has access to the private key — it only reads data from the API

To export a private key from Phantom:
Settings → Security & Privacy → Export Private Key → copy the base58 string

---

## Risk & Strategy Configuration

### Adjusting risk per trade

`TRADE_CAPITAL_PCT=0.02` means 2% of your wallet balance per trade.

- Conservative: `0.01` (1%)
- Standard: `0.02` (2%)  ← default
- Aggressive: `0.03` (3%) ← maximum allowed

### Stop loss

`STOP_LOSS_PCT=0.20` = exit if price drops 20% below entry.

For high-volatility memecoins, 20–25% is standard. Too tight (< 10%) causes excessive stop-outs from normal volatility.

### Take profit levels

Configured in `src/config/config.js` under `takeProfitLevels`:

```js
[
  { pct: 0.30, targetMul: 1.5 },   // Sell 30% at +50%
  { pct: 0.30, targetMul: 2.5 },   // Sell 30% at +150%
  { pct: 0.25, targetMul: 5.0 },   // Sell 25% at +400%
  // Last 15% managed by trailing stop
]
```

This "progressive exit" strategy locks in profit while keeping exposure to big moves.

### Minimum score

`MIN_SCORE=72` — only buy tokens scoring ≥72/100.

Raising this reduces trade frequency but increases quality. Recommended range: 68–80.

### Daily loss limit

`MAX_DAILY_LOSS_PCT=0.05` — halt trading if today's losses exceed 5% of starting balance.

---

## Running 24/7 on a VPS

### Recommended VPS specs
- 1 vCPU, 2GB RAM, 20GB SSD
- Ubuntu 22.04 or Debian 12
- Choose a datacenter close to Solana validators (US East / EU West / Tokyo)

### Setup

```bash
# On your VPS as root:
bash scripts/setup-vps.sh

# Then as your user:
cd backend
cp .env.example .env
nano .env         # fill in your config

npm install

# Start with PM2:
pm2 start ecosystem.config.js
pm2 save
pm2 startup       # follow the printed command to auto-start on boot
```

### Useful PM2 commands

```bash
pm2 logs solana-trader          # live log stream
pm2 restart solana-trader       # restart after config change
pm2 stop solana-trader          # stop without removing
pm2 monit                       # live resource monitor
pm2 list                        # show all processes
```

### Accessing the dashboard remotely

The API binds to `127.0.0.1` (localhost only) for security. To use the extension from your local machine:

```bash
# SSH tunnel on your local machine:
ssh -L 3001:127.0.0.1:3001 user@YOUR_VPS_IP -N
```

Then configure the extension to use `http://127.0.0.1:3001` as normal.

---

## Interpreting Results

### Good signs
- Win rate ≥ 55% over ≥ 30 trades
- Average win > average loss (positive profit factor)
- Daily P&L positive on most days
- No single trade > 3% of portfolio

### Warning signs
- Win rate dropping below 45% → raise `MIN_SCORE` or `MIN_LIQUIDITY_USD`
- Many stop-loss exits → widen `STOP_LOSS_PCT` slightly or tighten `MIN_SCORE`
- Emergency stops triggering → lower `TRADE_CAPITAL_PCT`, raise `MIN_SCORE`
- Honey-pot false positives → check Jupiter routing; may need higher `SLIPPAGE_BPS`

### Improving performance

1. Run `npm run backtest` after accumulating 50+ trades
2. Check which `exit_reason` generates the most losses
3. Adjust: if mostly `stop_loss` → tighter entries needed; if `volume_collapse` → reduce hold time
4. Simulate parameter changes with `SIMULATE=true` before going live

---

## Token Scoring Breakdown

| Component | Max Points | Key Metric |
|-----------|-----------|-----------|
| Liquidity | 25 | USD value of pool |
| Locked liquidity | 15 | % locked in lock contracts |
| Volume quality | 15 | Vol/liquidity ratio |
| Holder distribution | 15 | Count + concentration |
| Deployer quality | 10 | Mint/freeze renounced |
| Social hype | 10 | Twitter + Telegram score |
| Narrative match | 10 | Trending keyword match |
| **Total** | **100** | |

Default buy threshold: **72/100**

---

## Anti-Scam Filter Details

The bot rejects tokens that fail any of these checks:

| Check | What it detects |
|-------|----------------|
| Blacklist | Known scam contracts/deployers |
| Mint authority | Unlimited supply risk |
| Freeze authority | Tokens can be frozen/stolen |
| Honeypot simulation | Can't sell (simulates buy+sell) |
| Holder concentration | Top 10 > 50% = whale dump risk |
| Dev wallet size | Dev holds > 10% = rug risk |
| Wash trading | Vol/liquidity > 20–50x |
| Deployer history | High activity from fresh wallets |

---

## API Reference

All endpoints require header: `x-api-key: YOUR_API_KEY`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | Bot status, wallet, risk state |
| GET | `/api/stats` | Win rate, P&L, trade counts |
| GET | `/api/positions` | Open positions |
| GET | `/api/trades?limit=50&offset=0` | Trade history |
| GET | `/api/tokens?status=watching` | Scanned tokens with scores |
| GET | `/api/narratives` | Top trending social narratives |
| POST | `/api/emergency-stop` | `{ "active": true/false }` |
| POST | `/api/config` | Update runtime parameters |
| GET | `/api/blacklist` | View blacklisted addresses |
| POST | `/api/blacklist` | `{ "address", "type", "reason" }` |
| GET | `/api/backtest` | Run backtest, returns text output |
| WS | `/ws?apiKey=KEY` | Real-time event stream |

### WebSocket events

| Event | Payload |
|-------|---------|
| `buy` | `{ positionId, mint, symbol, solAmount, price, sig }` |
| `partial_sell` | `{ positionId, mint, sellPct, pnlSol, reason }` |
| `position_closed` | `{ positionId, mint, symbol, pnlSol, pnlPct, reason }` |
| `token_scored` | `{ mint, score, passed }` |
| `hype` | `{ mint, hypeScore, mentionCount, sentiment }` |
| `narrative` | `{ trends: string[] }` |

---

## Security Notes

- Private key is loaded from `.env` at startup, used only for in-memory signing, and never stored elsewhere
- The API server binds to `127.0.0.1` only — not accessible from the internet
- All sensitive config values can optionally be encrypted using `src/utils/encryption.js`
- The Chrome extension communicates only with `127.0.0.1:3001`
- No third-party services ever receive your private key

---

## Integrations

### Helius (recommended)
Get a free API key at helius.dev. Set:
```
RPC_ENDPOINTS=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
WS_ENDPOINT=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_API_KEY=YOUR_KEY
```

### Twitter v2 API
1. Apply at developer.twitter.com
2. Create a project and app
3. Get the **Bearer Token** (read-only access is sufficient)
4. Set `TWITTER_BEARER_TOKEN=...`

### Telegram monitoring
1. Message @BotFather on Telegram
2. `/newbot` → follow prompts → copy the token
3. Add your bot to the channels/groups you want to monitor
4. Set `TELEGRAM_BOT_TOKEN=...`
5. Set `TELEGRAM_CHANNELS=-1001234567890,-1009876543210` (your channel IDs)

To find a channel ID: forward a message from the channel to @userinfobot

### Jupiter & Raydium
These are public APIs — no API key required. The bot uses:
- Jupiter v6 for all swaps (best price routing across all DEXs)
- Raydium v2 API for pool data and new pool detection
