'use strict';

/**
 * Smart Money Tracker
 *
 * Monitors known profitable "smart money" wallets on-chain via Helius Enhanced
 * WebSocket. When 1+ smart wallets buy a new SPL token, emits a smartMoneySignal.
 *
 * Signal confidence tiers:
 *   1 wallet  → confidence 30
 *   2 wallets → confidence 65
 *   3+ wallets → confidence 85
 *
 * Dedup: same mint from same wallet within 5 minutes is skipped.
 * Aggregation window: 10 minutes — if 2+ different wallets buy same mint, emit
 * a higher-confidence signal.
 */

const EventEmitter = require('eventemitter3');
const WebSocket    = require('ws');
const config       = require('../config/config');
const logger       = require('../utils/logger');

// SPL Token program ID
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// Dedup window: same (wallet, mint) pair within 5 min → skip
const DEDUP_WINDOW_MS = 5 * 60_000;

// Aggregation window for multi-wallet signals
const AGGREGATION_WINDOW_MS = 10 * 60_000;

// Exponential backoff settings (ms)
const BACKOFF_BASE    = 5_000;
const BACKOFF_MAX     = 60_000;

class SmartMoneyTracker extends EventEmitter {
  constructor() {
    super();

    /** @type {string[]} */
    this._wallets = config.smartWallets || [];

    /** Single shared WebSocket for all wallets */
    this._ws = null;

    /** Map<`${wallet}:${mint}`, number> – last seen timestamp for dedup */
    this._seen = new Map();

    /**
     * Aggregation buffer:
     *   Map<mint, { wallets: Set<address>, firstTs: number }>
     */
    this._mintBuys = new Map();

    /** Current backoff delay for reconnect (ms) */
    this._backoff = BACKOFF_BASE;

    this._running = false;
    this._cleanupInterval = null;
  }

  // ── Public ──────────────────────────────────────────────────────────────────

  /**
   * Start monitoring all configured smart wallets.
   */
  start() {
    if (!config.solana.heliusApiKey) {
      logger.warn('[SmartMoney] No HELIUS_API_KEY — smart money tracking disabled');
      return;
    }
    if (!this._wallets.length) {
      logger.warn('[SmartMoney] No SMART_WALLETS configured — tracking disabled');
      return;
    }

    this._running = true;
    logger.info('[SmartMoney] Starting smart money tracker', { wallets: this._wallets.length });

    // Single connection monitors all wallets — avoids 429 rate limit
    this._connect();

    this._cleanupInterval = setInterval(() => this._cleanup(), 60_000);
  }

  /**
   * Stop all WebSocket connections and timers.
   */
  stop() {
    this._running = false;

    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }

    if (this._ws) {
      try { this._ws.terminate(); } catch { /* ignore */ }
      this._ws = null;
    }

    logger.info('[SmartMoney] Stopped');
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /**
   * Open ONE WebSocket connection monitoring all smart wallets simultaneously.
   * Helius accountInclude supports multiple addresses — no need for separate connections.
   */
  _connect() {
    if (!this._running) return;

    const url = `wss://atlas-mainnet.helius-rpc.com/?api-key=${config.solana.heliusApiKey}`;

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      logger.warn('[SmartMoney] Failed to create WebSocket', { err: err.message });
      this._scheduleReconnect();
      return;
    }

    this._ws = ws;

    ws.on('open', () => {
      logger.info('[SmartMoney] WS connected — monitoring', { wallets: this._wallets.length });
      this._backoff = BACKOFF_BASE; // reset backoff on success

      // All wallets in a single subscription
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'transactionSubscribe',
        params: [
          { accountInclude: this._wallets },
          {
            commitment: 'confirmed',
            encoding: 'jsonParsed',
            transactionDetails: 'full',
            showRewards: false,
            maxSupportedTransactionVersion: 0,
          },
        ],
      }));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this._handleMessage(msg);
      } catch (err) {
        logger.debug('[SmartMoney] Malformed WS message', { err: err.message });
      }
    });

    ws.on('error', (err) => {
      logger.warn('[SmartMoney] WS error', { err: err.message });
    });

    ws.on('close', (code) => {
      logger.warn('[SmartMoney] WS closed', { code });
      this._ws = null;
      this._scheduleReconnect();
    });
  }

  /**
   * Reconnect with exponential backoff.
   */
  _scheduleReconnect() {
    if (!this._running) return;

    const delay = Math.min(this._backoff, BACKOFF_MAX);
    this._backoff = Math.min(this._backoff * 2, BACKOFF_MAX);

    logger.info('[SmartMoney] Reconnecting', { delayMs: delay });
    setTimeout(() => this._connect(), delay);
  }

  /**
   * Parse an incoming WebSocket message and look for SPL token purchases.
   * @param {object} msg
   */
  _handleMessage(msg) {
    // Subscription confirmation
    if (msg.result && typeof msg.result === 'number' && msg.id === 1) {
      logger.debug('[SmartMoney] Subscribed', { subId: msg.result });
      return;
    }

    // Transaction notification
    const tx = msg?.params?.result?.transaction;
    if (!tx) return;

    const meta    = tx?.meta;
    const message = tx?.transaction?.message;
    if (!meta || !message) return;

    // Determine which of our wallets sent/received in this tx
    const accountKeys = (message.accountKeys || []).map(a => a.pubkey || a);
    const wallet = this._wallets.find(w => accountKeys.includes(w));
    if (!wallet) return;

    // Check if any instruction involves the SPL Token program
    const instructions = message.instructions || [];
    const hasSplTokenProgram = instructions.some(
      ix => ix.programId === TOKEN_PROGRAM_ID
    );
    if (!hasSplTokenProgram) return;

    // Extract mints from postTokenBalances where wallet is owner
    const postBalances = meta.postTokenBalances || [];
    const preBalances  = meta.preTokenBalances  || [];

    // Build pre-balance map: mint → amount
    const preMap = new Map();
    for (const bal of preBalances) {
      if (bal.owner === wallet) {
        const amount = Number(bal.uiTokenAmount?.uiAmount || 0);
        preMap.set(bal.mint, amount);
      }
    }

    // Find mints where wallet's balance increased (buy)
    for (const bal of postBalances) {
      if (bal.owner !== wallet) continue;

      const mint      = bal.mint;
      const postAmt   = Number(bal.uiTokenAmount?.uiAmount || 0);
      const preAmt    = preMap.get(mint) || 0;
      const delta     = postAmt - preAmt;

      if (delta <= 0) continue; // no increase — not a buy

      this._recordBuy(wallet, mint, delta);
    }
  }

  /**
   * Record a wallet-mint buy event, apply dedup, then check aggregation.
   * @param {string} wallet
   * @param {string} mint
   * @param {number} amount
   */
  _recordBuy(wallet, mint, amount) {
    const dedupKey = `${wallet}:${mint}`;
    const lastSeen = this._seen.get(dedupKey) || 0;
    const now      = Date.now();

    if (now - lastSeen < DEDUP_WINDOW_MS) {
      logger.debug('[SmartMoney] Dedup skip', { wallet: wallet.slice(0, 8), mint: mint.slice(0, 8) });
      return;
    }

    this._seen.set(dedupKey, now);

    logger.info('[SmartMoney] Smart wallet buy detected', {
      wallet: wallet.slice(0, 8) + '...',
      mint:   mint.slice(0, 8)   + '...',
      amount,
    });

    // Aggregate across wallets
    let entry = this._mintBuys.get(mint);
    if (!entry || now - entry.firstTs > AGGREGATION_WINDOW_MS) {
      // New or expired aggregation window
      entry = { wallets: new Set(), firstTs: now };
      this._mintBuys.set(mint, entry);
    }
    entry.wallets.add(wallet);

    const count      = entry.wallets.size;
    const confidence = count >= 3 ? 85 : count >= 2 ? 65 : 30;

    const signal = {
      mint,
      wallets:    [...entry.wallets],
      count,
      confidence,
      ts:         now,
    };

    logger.info('[SmartMoney] Emitting smartMoneySignal', {
      mint: mint.slice(0, 8) + '...',
      count,
      confidence,
    });

    this.emit('smartMoneySignal', signal);
  }

  /**
   * Remove stale entries from dedup and aggregation caches.
   */
  _cleanup() {
    const now = Date.now();

    for (const [key, ts] of this._seen) {
      if (now - ts > DEDUP_WINDOW_MS) this._seen.delete(key);
    }

    for (const [mint, entry] of this._mintBuys) {
      if (now - entry.firstTs > AGGREGATION_WINDOW_MS) this._mintBuys.delete(mint);
    }
  }
}

// Singleton
const instance = new SmartMoneyTracker();
module.exports = instance;
