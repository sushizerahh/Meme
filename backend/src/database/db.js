'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('../config/config');
const logger = require('../utils/logger');

let db;

function getDb() {
  if (db) return db;

  const dbPath = path.resolve(config.database.path);
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  migrate(db);
  logger.info(`[DB] Connected: ${dbPath}`);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      mint          TEXT PRIMARY KEY,
      symbol        TEXT,
      name          TEXT,
      decimals      INTEGER,
      deployer      TEXT,
      launch_ts     INTEGER,
      first_seen_ts INTEGER DEFAULT (unixepoch()),
      score         REAL,
      score_detail  TEXT,
      status        TEXT DEFAULT 'watching',  -- watching | bought | sold | skipped
      blacklisted   INTEGER DEFAULT 0,
      notes         TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tokens_status ON tokens(status);
    CREATE INDEX IF NOT EXISTS idx_tokens_score  ON tokens(score);

    -- ─── Positions ──────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS positions (
      id            TEXT PRIMARY KEY,
      mint          TEXT NOT NULL,
      symbol        TEXT,
      entry_price   REAL NOT NULL,
      entry_amount  REAL NOT NULL,  -- SOL spent
      tokens_bought REAL NOT NULL,
      remaining_pct REAL DEFAULT 1.0,
      stop_loss     REAL NOT NULL,
      trailing_stop REAL,
      status        TEXT DEFAULT 'open',  -- open | closed | emergency
      open_ts       INTEGER DEFAULT (unixepoch()),
      close_ts      INTEGER,
      pnl_sol       REAL,
      pnl_pct       REAL,
      exit_reason   TEXT,
      simulated     INTEGER DEFAULT 0,
      FOREIGN KEY(mint) REFERENCES tokens(mint)
    );

    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_positions_mint   ON positions(mint);

    -- ─── Trades (individual buy/sell txns) ───────────────────────────────────
    CREATE TABLE IF NOT EXISTS trades (
      id            TEXT PRIMARY KEY,
      position_id   TEXT,
      mint          TEXT NOT NULL,
      side          TEXT NOT NULL,  -- buy | sell
      price         REAL NOT NULL,
      amount_sol    REAL NOT NULL,
      amount_tokens REAL NOT NULL,
      tx_sig        TEXT,
      ts            INTEGER DEFAULT (unixepoch()),
      simulated     INTEGER DEFAULT 0,
      FOREIGN KEY(position_id) REFERENCES positions(id)
    );

    -- ─── Daily stats ─────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS daily_stats (
      date          TEXT PRIMARY KEY,
      trades        INTEGER DEFAULT 0,
      wins          INTEGER DEFAULT 0,
      losses        INTEGER DEFAULT 0,
      total_pnl_sol REAL DEFAULT 0,
      starting_sol  REAL DEFAULT 0,
      ending_sol    REAL DEFAULT 0
    );

    -- ─── Social signals ───────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS social_signals (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      mint          TEXT,
      source        TEXT,  -- twitter | telegram | generic
      mentions      INTEGER DEFAULT 0,
      sentiment     REAL DEFAULT 0,
      hype_score    REAL DEFAULT 0,
      ts            INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_social_mint ON social_signals(mint);

    -- ─── Blacklist ────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS blacklist (
      address       TEXT PRIMARY KEY,
      type          TEXT,  -- deployer | contract | wallet
      reason        TEXT,
      added_ts      INTEGER DEFAULT (unixepoch())
    );

    -- ─── Copy-trading wallets ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS copy_wallets (
      address       TEXT PRIMARY KEY,
      win_rate      REAL DEFAULT 0,
      avg_pnl       REAL DEFAULT 0,
      tracked_since INTEGER DEFAULT (unixepoch()),
      active        INTEGER DEFAULT 1
    );

    -- ─── System events / logs ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      type          TEXT,
      data          TEXT,
      ts            INTEGER DEFAULT (unixepoch())
    );
  `);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function upsertToken(token) {
  const db = getDb();
  db.prepare(`
    INSERT INTO tokens (mint, symbol, name, decimals, deployer, launch_ts, score, score_detail, status)
    VALUES (@mint, @symbol, @name, @decimals, @deployer, @launch_ts, @score, @score_detail, @status)
    ON CONFLICT(mint) DO UPDATE SET
      score        = excluded.score,
      score_detail = excluded.score_detail,
      status       = excluded.status
  `).run(token);
}

function getToken(mint) {
  return getDb().prepare('SELECT * FROM tokens WHERE mint = ?').get(mint);
}

function insertPosition(pos) {
  getDb().prepare(`
    INSERT INTO positions
      (id, mint, symbol, entry_price, entry_amount, tokens_bought, stop_loss, trailing_stop, simulated)
    VALUES
      (@id, @mint, @symbol, @entry_price, @entry_amount, @tokens_bought, @stop_loss, @trailing_stop, @simulated)
  `).run(pos);
}

function updatePosition(id, fields) {
  const sets = Object.keys(fields).map(k => `${k} = @${k}`).join(', ');
  getDb().prepare(`UPDATE positions SET ${sets} WHERE id = ?`).run({ ...fields }, id);
}

function getOpenPositions() {
  return getDb().prepare("SELECT * FROM positions WHERE status = 'open'").all();
}

function insertTrade(trade) {
  getDb().prepare(`
    INSERT INTO trades (id, position_id, mint, side, price, amount_sol, amount_tokens, tx_sig, simulated)
    VALUES (@id, @position_id, @mint, @side, @price, @amount_sol, @amount_tokens, @tx_sig, @simulated)
  `).run(trade);
}

function getTrades({ limit = 100, offset = 0 } = {}) {
  return getDb().prepare('SELECT * FROM trades ORDER BY ts DESC LIMIT ? OFFSET ?').all(limit, offset);
}

function getDailyStats(date) {
  return getDb().prepare('SELECT * FROM daily_stats WHERE date = ?').get(date)
    || { date, trades: 0, wins: 0, losses: 0, total_pnl_sol: 0 };
}

function updateDailyStats(date, delta) {
  const db = getDb();
  db.prepare(`
    INSERT INTO daily_stats (date, trades, wins, losses, total_pnl_sol)
    VALUES (@date, @trades, @wins, @losses, @total_pnl_sol)
    ON CONFLICT(date) DO UPDATE SET
      trades        = trades        + excluded.trades,
      wins          = wins          + excluded.wins,
      losses        = losses        + excluded.losses,
      total_pnl_sol = total_pnl_sol + excluded.total_pnl_sol
  `).run({ date, ...delta });
}

function insertSocialSignal(signal) {
  getDb().prepare(`
    INSERT INTO social_signals (mint, source, mentions, sentiment, hype_score)
    VALUES (@mint, @source, @mentions, @sentiment, @hype_score)
  `).run(signal);
}

function getLatestSocialSignal(mint) {
  return getDb().prepare(
    'SELECT * FROM social_signals WHERE mint = ? ORDER BY ts DESC LIMIT 1'
  ).get(mint);
}

function isBlacklisted(address) {
  return !!getDb().prepare('SELECT 1 FROM blacklist WHERE address = ?').get(address);
}

function addBlacklist(address, type, reason) {
  getDb().prepare(`
    INSERT OR IGNORE INTO blacklist (address, type, reason) VALUES (?, ?, ?)
  `).run(address, type, reason);
}

function logEvent(type, data) {
  try {
    getDb().prepare('INSERT INTO events (type, data) VALUES (?, ?)').run(type, JSON.stringify(data));
  } catch (_) {}
}

function getStats() {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const daily = getDailyStats(today);

  const overall = db.prepare(`
    SELECT
      COUNT(*) AS total_trades,
      SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) AS total_wins,
      SUM(CASE WHEN pnl_sol <= 0 THEN 1 ELSE 0 END) AS total_losses,
      SUM(pnl_sol) AS total_pnl_sol
    FROM positions
    WHERE status = 'closed'
  `).get();

  const open = db.prepare("SELECT COUNT(*) AS cnt FROM positions WHERE status = 'open'").get();

  return {
    daily,
    overall,
    open_positions: open.cnt,
    win_rate: overall.total_trades > 0
      ? (overall.total_wins / overall.total_trades * 100).toFixed(1) + '%'
      : 'N/A',
  };
}

module.exports = {
  getDb,
  upsertToken,
  getToken,
  insertPosition,
  updatePosition,
  getOpenPositions,
  insertTrade,
  getTrades,
  getDailyStats,
  updateDailyStats,
  insertSocialSignal,
  getLatestSocialSignal,
  isBlacklisted,
  addBlacklist,
  logEvent,
  getStats,
};
