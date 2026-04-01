'use strict';

/**
 * REST API Server
 *
 * Endpoints:
 *   GET  /api/status           – bot status, balance, risk state
 *   GET  /api/stats            – performance stats & win rate
 *   GET  /api/positions        – open positions
 *   GET  /api/trades           – trade history (paginated)
 *   GET  /api/tokens           – watched tokens with scores
 *   GET  /api/narratives       – top social narratives
 *   POST /api/emergency-stop   – toggle emergency stop
 *   POST /api/config           – update runtime config
 *   GET  /api/blacklist        – blacklisted addresses
 *   POST /api/blacklist        – add address to blacklist
 *   GET  /api/backtest         – run backtest on demand
 *   WS   /ws                  – real-time event stream
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const http = require('http');
const WebSocket = require('ws');
const config = require('../config/config');
const {
  getStats,
  getTrades,
  getOpenPositions,
  getDb,
  isBlacklisted,
  addBlacklist,
} = require('../database/db');
const { runBacktest } = require('../core/backtest');
const logger = require('../utils/logger');

function createApiServer(tradingEngine, socialMonitor) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server, path: '/ws' });

  // ── Middleware ──────────────────────────────────────────────────────────
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: ['chrome-extension://*', 'http://localhost:*'] }));
  app.use(express.json());

  // API key auth
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    const key = req.headers['x-api-key'];
    if (key !== config.server.apiKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });

  // ── REST Routes ─────────────────────────────────────────────────────────

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.get('/api/status', async (req, res) => {
    try {
      const wallet = tradingEngine.getWalletAddress();
      const riskCheck = tradingEngine.risk.canTrade();
      const openPos = getOpenPositions();

      res.json({
        running: true,
        simulate: config.trading.simulate,
        emergencyStop: tradingEngine.risk.isEmergencyStop(),
        canTrade: riskCheck.allowed,
        canTradeReason: riskCheck.reason,
        wallet,
        openPositions: openPos.length,
        maxPositions: config.trading.maxPositions,
        minScore: config.trading.minScoreToBuy,
        timestamp: Date.now(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/stats', (req, res) => {
    try {
      res.json(getStats());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/positions', (req, res) => {
    try {
      res.json(getOpenPositions());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/trades', (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || '50'), 500);
      const offset = parseInt(req.query.offset || '0');
      res.json(getTrades({ limit, offset }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/tokens', (req, res) => {
    try {
      const db = getDb();
      const status = req.query.status || null;
      const sql = status
        ? `SELECT * FROM tokens WHERE status = ? ORDER BY score DESC LIMIT 100`
        : `SELECT * FROM tokens ORDER BY first_seen_ts DESC LIMIT 100`;
      const tokens = status ? db.prepare(sql).all(status) : db.prepare(sql).all();
      res.json(tokens);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/narratives', (req, res) => {
    try {
      const trends = socialMonitor ? socialMonitor.getTopNarratives() : [];
      res.json({ trends, timestamp: Date.now() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/emergency-stop', (req, res) => {
    try {
      const { active } = req.body;
      tradingEngine.risk.setEmergencyStop(!!active);
      if (active) tradingEngine.emergencyCloseAll().catch(logger.error);
      res.json({ emergencyStop: !!active });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/config', (req, res) => {
    try {
      const allowed = [
        'minScoreToBuy', 'tradeCapitalPct', 'stopLossPct',
        'maxPositions', 'sniperDelayMin', 'sniperDelayMax',
        'maxDailyLossPct',
      ];
      const updates = {};
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          if (key in config.trading) config.trading[key] = req.body[key];
          if (key in config.risk) config.risk[key] = req.body[key];
          updates[key] = req.body[key];
        }
      }
      logger.info('[API] Config updated', updates);
      res.json({ updated: updates });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/blacklist', (req, res) => {
    try {
      const db = getDb();
      res.json(db.prepare('SELECT * FROM blacklist ORDER BY added_ts DESC').all());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/blacklist', (req, res) => {
    try {
      const { address, type = 'contract', reason = 'manual' } = req.body;
      if (!address) return res.status(400).json({ error: 'address required' });
      addBlacklist(address, type, reason);
      res.json({ added: true, address });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/backtest', (req, res) => {
    try {
      // Capture console output
      const lines = [];
      const orig = console.log;
      console.log = (...args) => lines.push(args.join(' '));
      runBacktest();
      console.log = orig;
      res.json({ output: lines.join('\n') });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── WebSocket real-time events ──────────────────────────────────────────
  const wsClients = new Set();

  wss.on('connection', (ws, req) => {
    // Validate API key from query string
    const url = new URL(`http://localhost${req.url}`);
    const key = url.searchParams.get('apiKey');
    if (key !== config.server.apiKey) {
      ws.close(1008, 'Unauthorized');
      return;
    }

    wsClients.add(ws);
    logger.debug('[WS] Client connected', { total: wsClients.size });

    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);
        if (data.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch (_) {}
    });

    ws.on('close', () => {
      wsClients.delete(ws);
      logger.debug('[WS] Client disconnected');
    });

    // Send current state immediately on connect
    ws.send(JSON.stringify({ type: 'init', data: getStats() }));
  });

  function broadcast(type, data) {
    const msg = JSON.stringify({ type, data, ts: Date.now() });
    for (const client of wsClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  // Bridge trading engine events → WS clients
  if (tradingEngine) {
    tradingEngine.on('buy', d => broadcast('buy', d));
    tradingEngine.on('partialSell', d => broadcast('partial_sell', d));
    tradingEngine.on('positionClosed', d => broadcast('position_closed', d));
    tradingEngine.on('tokenScored', d => broadcast('token_scored', d));
    tradingEngine.on('buyError', d => broadcast('buy_error', d));
  }

  if (socialMonitor) {
    socialMonitor.on('hype', d => broadcast('hype', d));
    socialMonitor.on('narrativeUpdate', d => broadcast('narrative', d));
  }

  // ── Start ───────────────────────────────────────────────────────────────
  function start() {
    server.listen(config.server.port, config.server.host, () => {
      logger.info(`[API] Server running at http://${config.server.host}:${config.server.port}`);
    });
  }

  return { app, server, start, broadcast };
}

module.exports = { createApiServer };
