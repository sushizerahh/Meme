'use strict';

require('dotenv').config();

const config      = require('./config/config');
const { getDb }   = require('./database/db');
const { startRpcManager } = require('./dex/index');
const TokenScanner  = require('./core/scanner');
const TradingEngine = require('./core/trader');
const CopyTrader    = require('./core/copytrader');
const SocialMonitor = require('./social/social');
const { createApiServer } = require('./api/server');
const logger        = require('./utils/logger');

async function main() {
  logger.info('╔═══════════════════════════════════════════════╗');
  logger.info('║   Solana Memecoin Trader  v2.0                ║');
  logger.info(`║   Mode: ${config.trading.simulate ? 'SIMULATION 🔵' : 'LIVE TRADING 🔴'}                    ║`);
  logger.info('╚═══════════════════════════════════════════════╝');

  // Validate
  if (!config.trading.simulate && !process.env.WALLET_PRIVATE_KEY) {
    logger.error('WALLET_PRIVATE_KEY not set. Use SIMULATE=true or set the key.');
    process.exit(1);
  }

  // Init DB
  getDb();

  // Start RPC manager (health checks + latency tracking)
  startRpcManager();

  // Build subsystems
  const social    = new SocialMonitor();
  const scanner   = new TokenScanner();
  const engine    = new TradingEngine();
  const copyTrader = new CopyTrader(engine);

  // Load wallet keypair
  if (process.env.WALLET_PRIVATE_KEY) {
    try {
      engine.setKeypair(process.env.WALLET_PRIVATE_KEY);
    } catch (err) {
      logger.error('Invalid WALLET_PRIVATE_KEY', { err: err.message });
      if (!config.trading.simulate) process.exit(1);
    }
  }

  // API + WebSocket server
  const api = createApiServer(engine, social);

  // ── Event wiring ──────────────────────────────────────────────────────────

  // New token from scanner → decision engine
  scanner.on('newToken', token =>
    engine.processNewToken(token).catch(err =>
      logger.error('[Main] processNewToken error', { err: err.message })
    )
  );

  // Social hype → enrich decisions (future: could bump tokens in watchlist)
  social.on('hype', ({ mint, hypeScore, source, influencerCount }) => {
    logger.info('[Main] Hype alert', { mint, hypeScore, source, influencerCount });
  });

  // Suspicious pump → warn but don't reject automatically (Decision Engine handles it)
  social.on('suspiciousPump', ({ mint, totalMentions, source }) => {
    logger.warn('[Main] Suspected coordinated pump', { mint, totalMentions, source });
  });

  // Trade results → console summary
  engine.on('positionClosed', ({ symbol, pnlSol, pnlPct, trigger }) => {
    const tag = pnlSol > 0 ? '✅' : '❌';
    logger.info(`${tag} CLOSED ${symbol} | ${pnlSol?.toFixed(4)} SOL (${pnlPct?.toFixed(1)}%) | ${trigger}`);
  });

  engine.on('buy', ({ symbol, solAmount, price, latencyMs }) => {
    logger.info(`🟢 BUY ${symbol} | ${solAmount?.toFixed(3)} SOL @ ${price?.toFixed(8)} | ${latencyMs}ms`);
  });

  // ── Start all systems ─────────────────────────────────────────────────────
  social.start();
  engine.start();
  scanner.start();
  copyTrader.start();
  api.start();

  logger.info(`[Main] All systems operational`);
  logger.info(`[Main] API: http://${config.server.host}:${config.server.port}`);
  logger.info(`[Main] WS:  ws://${config.server.host}:${config.server.port}/ws`);

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = (signal) => {
    logger.warn(`[Main] ${signal} — shutting down`);
    scanner.stop();
    copyTrader.stop();
    social.stop();
    engine.stop();
    process.exit(0);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', err => {
    logger.error('[Main] Uncaught exception', { err: err.message, stack: err.stack });
  });
  process.on('unhandledRejection', reason => {
    logger.error('[Main] Unhandled rejection', { reason: String(reason) });
  });
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
