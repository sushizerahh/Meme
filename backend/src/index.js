'use strict';

/**
 * Main entry point
 *
 * Startup sequence:
 *   1. Load config & validate
 *   2. Init database
 *   3. Start social monitor
 *   4. Start token scanner
 *   5. Start trading engine
 *   6. Start API server
 *   7. Wire events together
 */

require('dotenv').config();
const config = require('./config/config');
const { getDb } = require('./database/db');
const TokenScanner = require('./core/scanner');
const TradingEngine = require('./core/trader');
const CopyTrader = require('./core/copytrader');
const SocialMonitor = require('./social/social');
const { createApiServer } = require('./api/server');
const logger = require('./utils/logger');

async function main() {
  logger.info('═══════════════════════════════════════════════');
  logger.info('  Solana Memecoin Trader — Starting Up         ');
  logger.info(`  Mode: ${config.trading.simulate ? 'SIMULATION' : 'LIVE'}         `);
  logger.info('═══════════════════════════════════════════════');

  // Validate required config
  if (!config.trading.simulate && !process.env.WALLET_PRIVATE_KEY) {
    logger.error('WALLET_PRIVATE_KEY not set. Set it in .env or run with --simulate');
    process.exit(1);
  }

  // Init DB
  getDb();

  // Social monitor
  const social = new SocialMonitor();
  social.start();

  // Token scanner
  const scanner = new TokenScanner();

  // Trading engine
  const engine = new TradingEngine();

  if (process.env.WALLET_PRIVATE_KEY) {
    try {
      engine.setKeypair(process.env.WALLET_PRIVATE_KEY);
    } catch (err) {
      logger.error('Invalid WALLET_PRIVATE_KEY', { err: err.message });
      if (!config.trading.simulate) process.exit(1);
    }
  }

  // Copy trader
  const copyTrader = new CopyTrader(engine);

  // API server
  const api = createApiServer(engine, social);

  // ── Wire events ──────────────────────────────────────────────────────────

  // Social hype → enrich token score when hype detected
  social.on('hype', ({ mint, hypeScore }) => {
    logger.info('[Main] Social hype detected', { mint, hypeScore });
  });

  // Twitter/Telegram mention → update token on watchlist
  social.on('tweetMention', ({ symbol, sentiment }) => {
    logger.debug('[Main] Tweet mention', { symbol, sentiment });
  });

  // Scanner → trading engine
  scanner.on('newToken', async (tokenInfo) => {
    await engine.processNewToken(tokenInfo).catch(err =>
      logger.error('[Main] processNewToken error', { err: err.message })
    );
  });

  // Trading events → logger
  engine.on('positionClosed', ({ mint, symbol, pnlSol, pnlPct, reason }) => {
    const emoji = pnlSol > 0 ? '✅' : '❌';
    logger.info(`${emoji} Trade closed: ${symbol} | PnL: ${pnlSol?.toFixed(4)} SOL (${pnlPct?.toFixed(1)}%) | ${reason}`);
  });

  // ── Start all systems ────────────────────────────────────────────────────

  engine.start();
  scanner.start();
  copyTrader.start();
  api.start();

  logger.info('[Main] All systems operational');
  logger.info(`[Main] Dashboard available at http://${config.server.host}:${config.server.port}`);
  logger.info(`[Main] WebSocket at ws://${config.server.host}:${config.server.port}/ws`);

  // ── Graceful shutdown ────────────────────────────────────────────────────

  const shutdown = async (signal) => {
    logger.warn(`[Main] ${signal} received – shutting down gracefully...`);
    scanner.stop();
    copyTrader.stop();
    social.stop();
    engine.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    logger.error('[Main] Uncaught exception', { err: err.message, stack: err.stack });
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('[Main] Unhandled rejection', { reason: String(reason) });
  });
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
