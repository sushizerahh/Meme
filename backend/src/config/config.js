'use strict';
require('dotenv').config();

const config = {
  // ─── Server ───────────────────────────────────────────────────────────────
  server: {
    port: parseInt(process.env.PORT || '3001'),
    host: process.env.HOST || '127.0.0.1',
    apiKey: process.env.API_KEY || 'change-me-in-env',
  },

  // ─── Solana RPC ───────────────────────────────────────────────────────────
  solana: {
    rpcEndpoints: (process.env.RPC_ENDPOINTS || 'https://api.mainnet-beta.solana.com')
      .split(',').map(s => s.trim()),
    wsEndpoint: process.env.WS_ENDPOINT || 'wss://api.mainnet-beta.solana.com',
    commitment: 'confirmed',
    // Private RPCs (Helius, Triton, QuickNode, etc.)
    heliusApiKey: process.env.HELIUS_API_KEY || '',
    quicknodeEndpoint: process.env.QUICKNODE_ENDPOINT || '',
    // Transaction priority fee in micro-lamports
    priorityFee: parseInt(process.env.PRIORITY_FEE || '100000'),
    maxRetries: 3,
  },

  // ─── Trading parameters ───────────────────────────────────────────────────
  trading: {
    // Capital per trade as fraction of wallet balance (1–30%)
    tradeCapitalPct: parseFloat(process.env.TRADE_CAPITAL_PCT || '0.02'),
    minTradeCapitalPct: parseFloat(process.env.MIN_TRADE_CAPITAL_PCT || '0.01'),
    maxTradeCapitalPct: parseFloat(process.env.MAX_TRADE_CAPITAL_PCT || '0.30'),

    // Minimum score to allow a buy (0–100)
    minScoreToBuy: parseInt(process.env.MIN_SCORE || '72'),

    // Sniper delay after token launch (ms)
    sniperDelayMin: parseInt(process.env.SNIPER_DELAY_MIN || '10000'),  // 10s
    sniperDelayMax: parseInt(process.env.SNIPER_DELAY_MAX || '30000'),  // 30s

    // Slippage tolerance (basis points, 100 = 1%)
    slippageBps: parseInt(process.env.SLIPPAGE_BPS || '300'),

    // Take-profit levels: [{ pct: fraction of position, targetMul: price multiplier }]
    takeProfitLevels: [
      { pct: 0.30, targetMul: 1.5 },   // Sell 30% at +50%
      { pct: 0.30, targetMul: 2.5 },   // Sell 30% at +150%
      { pct: 0.25, targetMul: 5.0 },   // Sell 25% at +400%
      // Remaining 15% managed by trailing stop
    ],

    // Stop loss (fraction below entry, e.g. 0.20 = -20%)
    stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || '0.20'),

    // Trailing stop: activate after X% gain, trail by Y%
    trailingStopActivatePct: parseFloat(process.env.TRAILING_ACTIVATE || '0.30'),
    trailingStopPct: parseFloat(process.env.TRAILING_STOP_PCT || '0.15'),

    // Max concurrent open positions
    maxPositions: parseInt(process.env.MAX_POSITIONS || '5'),

    // Maximum age of a token to consider sniping (seconds)
    maxTokenAgeSeconds: parseInt(process.env.MAX_TOKEN_AGE || '120'),

    // Simulation mode (no real trades)
    simulate: process.argv.includes('--simulate') || process.env.SIMULATE === 'true',
  },

  // ─── Risk management ─────────────────────────────────────────────────────
  risk: {
    // Max daily loss as fraction of starting daily balance
    maxDailyLossPct: parseFloat(process.env.MAX_DAILY_LOSS_PCT || '0.05'),

    // Consecutive losses before auto-halt
    maxConsecutiveLosses: parseInt(process.env.MAX_CONSECUTIVE_LOSSES || '4'),

    // Hours to pause after hitting loss limit
    pauseAfterLossHours: parseFloat(process.env.PAUSE_HOURS || '4'),

    // Emergency stop triggered from dashboard
    emergencyStop: false,
  },

  // ─── Token filters (minimum requirements) ────────────────────────────────
  filters: {
    // Minimum liquidity in USD
    minLiquidityUsd: parseFloat(process.env.MIN_LIQUIDITY_USD || '15000'),

    // Minimum holder count
    minHolders: parseInt(process.env.MIN_HOLDERS || '50'),

    // Top-10 holders may hold at most this fraction (0.50 = 50%)
    maxTop10HoldersPct: parseFloat(process.env.MAX_TOP10_PCT || '0.50'),

    // Dev/deployer max wallet share
    maxDevWalletPct: parseFloat(process.env.MAX_DEV_PCT || '0.10'),

    // Minimum locked liquidity fraction
    minLockedLiquidityPct: parseFloat(process.env.MIN_LOCKED_LIQ || '0.70'),

    // Require verified/renounced mint authority
    requireMintRenounced: process.env.REQUIRE_MINT_RENOUNCED !== 'false',

    // Require renounced freeze authority
    requireFreezeRenounced: process.env.REQUIRE_FREEZE_RENOUNCED !== 'false',

    // Blacklisted deployer addresses (comma-separated)
    blacklistDeployers: (process.env.BLACKLIST_DEPLOYERS || '').split(',').filter(Boolean),

    // Blacklisted contract addresses
    blacklistContracts: (process.env.BLACKLIST_CONTRACTS || '').split(',').filter(Boolean),
  },

  // ─── Social / AI hype layer ───────────────────────────────────────────────
  social: {
    // Twitter Bearer token (v2 API)
    twitterBearerToken: process.env.TWITTER_BEARER_TOKEN || '',

    // Telegram bot token + channel ids to monitor
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChannels: (process.env.TELEGRAM_CHANNELS || '').split(',').filter(Boolean),

    // Minimum mention growth rate (mentions/minute) to score as "hype"
    minMentionGrowthRate: parseFloat(process.env.MIN_MENTION_GROWTH || '5'),

    // Score weights for sentiment signals
    sentimentWeight: parseFloat(process.env.SENTIMENT_WEIGHT || '0.25'),
  },

  // ─── DEX settings ─────────────────────────────────────────────────────────
  dex: {
    jupiterApiUrl: process.env.JUPITER_API_URL || 'https://quote-api.jup.ag/v6',
    raydiumApiUrl: process.env.RAYDIUM_API_URL || 'https://api.raydium.io/v2',

    // WSOL mint address
    wsolMint: 'So11111111111111111111111111111111111111112',

    // USDC mint address
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  },

  // ─── Copy trading ─────────────────────────────────────────────────────────
  copyTrading: {
    enabled: process.env.COPY_TRADING_ENABLED === 'true',
    // Wallets to monitor for copy-trading (comma-separated)
    trackedWallets: (process.env.COPY_WALLETS || '').split(',').filter(Boolean),
    // Minimum wallet 30d win rate to follow
    minWinRate: parseFloat(process.env.COPY_MIN_WIN_RATE || '0.60'),
    // Max delay after wallet's own tx (ms)
    maxCopyDelayMs: parseInt(process.env.COPY_MAX_DELAY_MS || '5000'),
  },

  // ─── Database ─────────────────────────────────────────────────────────────
  database: {
    path: process.env.DB_PATH || './data/trading.db',
  },

  // ─── Logging ─────────────────────────────────────────────────────────────
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    logDir: process.env.LOG_DIR || './logs',
  },
};

module.exports = config;
