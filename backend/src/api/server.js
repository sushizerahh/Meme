'use strict';

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const http      = require('http');
const WebSocket = require('ws');

const config    = require('../config/config');
const {
  getStats, getTrades, getOpenPositions, getDb,
  isBlacklisted, addBlacklist,
} = require('../database/db');
const { runHistoricalBacktest, runScenarioBacktest } = require('../core/backtest');
const { rpcManager } = require('../dex/index');
const logger    = require('../utils/logger');

function createApiServer(tradingEngine, socialMonitor) {
  const app    = express();
  const server = http.createServer(app);
  const wss    = new WebSocket.Server({ server, path: '/ws' });

  // ── Middleware ──────────────────────────────────────────────────────────
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: ['chrome-extension://*', 'http://localhost:*', 'http://127.0.0.1:*'] }));
  app.use(express.json());

  // API key auth
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    if (req.headers['x-api-key'] !== config.server.apiKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });

  // ── Routes ──────────────────────────────────────────────────────────────

  app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

  app.get('/api/status', async (req, res) => {
    try {
      const riskState = tradingEngine.risk.getState();
      const openPos   = getOpenPositions();
      res.json({
        running:      true,
        simulate:     config.trading.simulate,
        wallet:       tradingEngine.getWalletAddress(),
        openPositions: openPos.length,
        maxPositions:  config.trading.maxPositions,
        minScore:      config.trading.minScoreToBuy,
        rpc:           rpcManager.getStats(),
        risk:          riskState,
        timestamp:     Date.now(),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/stats', (_, res) => {
    try { res.json(getStats()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/positions', (_, res) => {
    try { res.json(getOpenPositions()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/trades', (req, res) => {
    try {
      const limit  = Math.min(parseInt(req.query.limit  || '50'), 500);
      const offset = parseInt(req.query.offset || '0');
      res.json(getTrades({ limit, offset }));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/tokens', (req, res) => {
    try {
      const db     = getDb();
      const status = req.query.status || null;
      const limit  = Math.min(parseInt(req.query.limit || '100'), 500);
      const rows   = status
        ? db.prepare('SELECT * FROM tokens WHERE status = ? ORDER BY score DESC LIMIT ?').all(status, limit)
        : db.prepare('SELECT * FROM tokens ORDER BY first_seen_ts DESC LIMIT ?').all(limit);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/narratives', (_, res) => {
    try {
      const trends = socialMonitor?.getTopNarratives() || [];
      res.json({ trends, timestamp: Date.now() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/scorer/weights', (_, res) => {
    try {
      res.json(tradingEngine.decision.scorer.getWeights());
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/scorer/weights/reset', (_, res) => {
    try {
      tradingEngine.decision.scorer.resetWeights();
      res.json({ ok: true, weights: tradingEngine.decision.scorer.getWeights() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/rpc', (_, res) => {
    try { res.json(rpcManager.getStats()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/emergency-stop', (req, res) => {
    try {
      const { active } = req.body;
      tradingEngine.risk.setEmergencyStop(!!active);
      if (active) tradingEngine.emergencyCloseAll().catch(logger.error);
      res.json({ emergencyStop: !!active });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/config', (req, res) => {
    try {
      const ALLOWED = {
        trading: ['minScoreToBuy', 'tradeCapitalPct', 'stopLossPct', 'maxPositions',
                  'sniperDelayMin', 'sniperDelayMax', 'trailingStopActivatePct', 'trailingStopPct'],
        risk:    ['maxDailyLossPct', 'maxConsecutiveLosses', 'pauseAfterLossHours'],
      };
      const updates = {};
      for (const [section, keys] of Object.entries(ALLOWED)) {
        for (const key of keys) {
          if (req.body[key] !== undefined) {
            config[section][key] = req.body[key];
            updates[key] = req.body[key];
          }
        }
      }
      logger.info('[API] Config updated', updates);
      res.json({ updated: updates });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/blacklist', (_, res) => {
    try {
      res.json(getDb().prepare('SELECT * FROM blacklist ORDER BY added_ts DESC LIMIT 200').all());
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/blacklist', (req, res) => {
    try {
      const { address, type = 'contract', reason = 'manual' } = req.body;
      if (!address) return res.status(400).json({ error: 'address required' });
      addBlacklist(address, type, reason);
      res.json({ added: true, address });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/backtest', (req, res) => {
    try {
      const lines  = [];
      const orig   = console.log;
      console.log  = (...a) => lines.push(a.join(' '));
      const result = runHistoricalBacktest({ verbose: req.query.verbose === 'true' });
      console.log  = orig;
      res.json({ output: lines.join('\n'), result });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/backtest/scenario', (_, res) => {
    try {
      const lines = [];
      const orig  = console.log;
      console.log = (...a) => lines.push(a.join(' '));
      runScenarioBacktest();
      console.log = orig;
      res.json({ output: lines.join('\n') });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/copytrading/ranking', (_, res) => {
    try {
      // CopyTrader is not directly accessible here — expose via engine if needed
      res.json({ note: 'Rankings logged periodically to console/file' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── WebSocket ────────────────────────────────────────────────────────────
  const wsClients = new Set();

  wss.on('connection', (ws, req) => {
    const url = new URL(`http://localhost${req.url}`);
    if (url.searchParams.get('apiKey') !== config.server.apiKey) {
      ws.close(1008, 'Unauthorized');
      return;
    }
    wsClients.add(ws);
    logger.debug('[WS] Client connected', { total: wsClients.size });

    ws.on('message', msg => {
      try {
        const d = JSON.parse(msg);
        if (d.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch {}
    });

    ws.on('close', () => { wsClients.delete(ws); });

    // Send initial state
    try {
      ws.send(JSON.stringify({ type: 'init', data: getStats(), ts: Date.now() }));
    } catch {}
  });

  function broadcast(type, data) {
    const msg = JSON.stringify({ type, data, ts: Date.now() });
    for (const client of wsClients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(msg); } catch {}
      }
    }
  }

  // Bridge events → WS
  if (tradingEngine) {
    tradingEngine.on('buy',            d => broadcast('buy', d));
    tradingEngine.on('partialSell',    d => broadcast('partial_sell', d));
    tradingEngine.on('positionClosed', d => broadcast('position_closed', d));
    tradingEngine.on('tokenScored',    d => broadcast('token_scored', d));
    tradingEngine.on('buyError',       d => broadcast('buy_error', d));
    tradingEngine.on('sellError',      d => broadcast('sell_error', d));
  }
  if (socialMonitor) {
    socialMonitor.on('hype',             d => broadcast('hype', d));
    socialMonitor.on('narrativeUpdate',  d => broadcast('narrative', d));
    socialMonitor.on('influencerMention', d => broadcast('influencer', d));
    socialMonitor.on('suspiciousPump',   d => broadcast('suspicious_pump', d));
  }

  function start() {
    server.listen(config.server.port, config.server.host, () => {
      logger.info(`[API] http://${config.server.host}:${config.server.port}`);
    });
  }

  return { app, server, start, broadcast };
}

module.exports = { createApiServer };
