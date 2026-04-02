'use strict';

/**
 * Dev Wallet Watcher
 *
 * Monitors the deployer/dev wallet of tokens currently held in a position.
 * If the dev sells a significant portion of their holdings during our position,
 * emits an urgent exit signal.
 *
 * Usage:
 *   devWatcher.watch(mint, devAddress, positionOpenTs)
 *   devWatcher.unwatch(mint)
 *
 * Events emitted:
 *   'devSellWarning' – dev sold >15% of holdings (partial sell)
 *   'devSellAlert'   – dev sold >40% of holdings (major sell, strong exit signal)
 */

const EventEmitter = require('eventemitter3');
const axios        = require('axios');
const config       = require('../config/config');
const logger       = require('../utils/logger');

// Poll every 15 seconds per watched token
const POLL_INTERVAL_MS = 15_000;

// Sell threshold percentages
const WARN_THRESHOLD  = 0.15;  // 15% sold → warning
const ALERT_THRESHOLD = 0.40;  // 40% sold → alert (strong exit signal)

// Rate-limit backoff
const RATE_LIMIT_BACKOFF_MS = 30_000;

class DevWatcher extends EventEmitter {
  constructor() {
    super();

    /**
     * Map<mint, {
     *   devAddress: string,
     *   positionOpenTs: number,
     *   initialBalance: number|null,
     *   soldPct: number,
     *   warnEmitted: boolean,
     *   alertEmitted: boolean,
     *   timer: NodeJS.Timeout|null,
     *   rateLimitedUntil: number,
     * }>
     */
    this._watched = new Map();

    this._enabled = !!config.solana.heliusApiKey;

    if (!this._enabled) {
      logger.debug('[DevWatcher] No HELIUS_API_KEY — dev wallet monitoring disabled');
    }
  }

  // ── Public ──────────────────────────────────────────────────────────────────

  /**
   * Begin monitoring a dev wallet for a token we hold.
   * @param {string} mint           – SPL token mint address
   * @param {string} devAddress     – deployer/dev wallet address
   * @param {number} positionOpenTs – timestamp (ms) when position was opened
   */
  watch(mint, devAddress, positionOpenTs) {
    if (!this._enabled) return;
    if (this._watched.has(mint)) return; // already watching

    logger.info('[DevWatcher] Watching dev wallet', {
      mint: mint.slice(0, 8) + '...',
      dev:  devAddress.slice(0, 8) + '...',
    });

    const entry = {
      devAddress,
      positionOpenTs,
      initialBalance:   null,
      soldPct:          0,
      warnEmitted:      false,
      alertEmitted:     false,
      timer:            null,
      rateLimitedUntil: 0,
    };

    this._watched.set(mint, entry);

    // Fetch initial balance then start polling
    this._fetchInitialBalance(mint, devAddress, entry).then(() => {
      if (this._watched.has(mint)) {
        entry.timer = setInterval(
          () => this._poll(mint).catch(err =>
            logger.debug('[DevWatcher] Poll error', { mint: mint.slice(0, 8), err: err.message })
          ),
          POLL_INTERVAL_MS
        );
      }
    }).catch(err => {
      logger.warn('[DevWatcher] Failed to fetch initial balance', { err: err.message });
      // Still start polling even without initial balance
      entry.timer = setInterval(
        () => this._poll(mint).catch(err2 =>
          logger.debug('[DevWatcher] Poll error', { mint: mint.slice(0, 8), err: err2.message })
        ),
        POLL_INTERVAL_MS
      );
    });
  }

  /**
   * Stop monitoring a dev wallet (call when position closes).
   * @param {string} mint
   */
  unwatch(mint) {
    const entry = this._watched.get(mint);
    if (!entry) return;

    if (entry.timer) {
      clearInterval(entry.timer);
      entry.timer = null;
    }

    this._watched.delete(mint);
    logger.debug('[DevWatcher] Unwatched', { mint: mint.slice(0, 8) + '...' });
  }

  /**
   * Returns all currently watched mints.
   * @returns {string[]}
   */
  watchedMints() {
    return [...this._watched.keys()];
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /**
   * Fetch and store dev wallet's initial token balance.
   * @param {string} mint
   * @param {string} devAddress
   * @param {object} entry
   */
  async _fetchInitialBalance(mint, devAddress, entry) {
    const url = `https://api.helius.xyz/v0/addresses/${devAddress}/balances?api-key=${config.solana.heliusApiKey}`;

    try {
      const { data } = await axios.get(url, { timeout: 10_000 });

      const tokens = data?.tokens || [];
      const token  = tokens.find(t => t.mint === mint);

      if (token) {
        entry.initialBalance = token.amount || 0;
        logger.debug('[DevWatcher] Initial dev balance', {
          mint: mint.slice(0, 8) + '...',
          balance: entry.initialBalance,
        });
      } else {
        // Dev may have already dumped or hasn't received tokens
        entry.initialBalance = 0;
        logger.debug('[DevWatcher] Dev holds no tokens at watch start', { mint: mint.slice(0, 8) });
      }
    } catch (err) {
      const status = err.response?.status;
      if (status === 429) {
        logger.warn('[DevWatcher] Rate limited fetching initial balance — will retry on next poll');
        entry.rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
      } else {
        logger.warn('[DevWatcher] Could not fetch initial balance', { err: err.message });
      }
    }
  }

  /**
   * Poll Helius for recent swap transactions from the dev wallet.
   * @param {string} mint
   */
  async _poll(mint) {
    const entry = this._watched.get(mint);
    if (!entry) return;

    // Respect rate-limit backoff
    if (Date.now() < entry.rateLimitedUntil) return;

    const { devAddress } = entry;

    let transactions;
    try {
      const url = `https://api.helius.xyz/v0/addresses/${devAddress}/transactions` +
        `?api-key=${config.solana.heliusApiKey}&type=SWAP`;

      const { data } = await axios.get(url, { timeout: 10_000 });
      transactions = data || [];
    } catch (err) {
      const status = err.response?.status;
      if (status === 429) {
        logger.warn('[DevWatcher] Rate limited — backing off 30s', { mint: mint.slice(0, 8) });
        entry.rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
      } else {
        logger.debug('[DevWatcher] Fetch error', { mint: mint.slice(0, 8), err: err.message });
      }
      return;
    }

    // Filter to transactions after position opened and involving our mint
    const positionOpenSec = Math.floor(entry.positionOpenTs / 1000);
    const relevant = transactions.filter(tx => {
      if ((tx.timestamp || 0) < positionOpenSec) return false;
      // tokenTransfers where dev is source and mint matches
      const transfers = tx.tokenTransfers || [];
      return transfers.some(t =>
        t.fromUserAccount === devAddress &&
        t.mint === mint &&
        (t.tokenAmount || 0) > 0
      );
    });

    if (!relevant.length) return;

    // Sum total tokens sold
    let totalSold = 0;
    for (const tx of relevant) {
      for (const t of tx.tokenTransfers || []) {
        if (t.fromUserAccount === devAddress && t.mint === mint) {
          totalSold += t.tokenAmount || 0;
        }
      }
    }

    // If we never got an initial balance, try to infer from current balance
    if (entry.initialBalance === null || entry.initialBalance === 0) {
      // Fetch current balance and treat sold + current as initial
      await this._fetchInitialBalance(mint, devAddress, entry);
    }

    const initialBalance = entry.initialBalance;
    if (!initialBalance || initialBalance <= 0) return;

    const soldPct = totalSold / initialBalance;
    entry.soldPct = soldPct;

    logger.debug('[DevWatcher] Dev sell check', {
      mint: mint.slice(0, 8) + '...',
      soldPct: (soldPct * 100).toFixed(1) + '%',
    });

    // ── Alert thresholds ────────────────────────────────────────────────────

    if (!entry.alertEmitted && soldPct >= ALERT_THRESHOLD) {
      entry.alertEmitted = true;
      entry.warnEmitted  = true; // suppress lower-tier warning

      const signal = {
        mint,
        devAddress,
        soldPct,
        totalSold,
        initialBalance,
        urgency: 'emergency',
        ts: Date.now(),
      };

      logger.warn('[DevWatcher] DEV SELL ALERT — major sell detected', {
        mint: mint.slice(0, 8) + '...',
        soldPct: (soldPct * 100).toFixed(1) + '%',
      });

      this.emit('devSellAlert', signal);

    } else if (!entry.warnEmitted && soldPct >= WARN_THRESHOLD) {
      entry.warnEmitted = true;

      const signal = {
        mint,
        devAddress,
        soldPct,
        totalSold,
        initialBalance,
        urgency: 'fast',
        ts: Date.now(),
      };

      logger.warn('[DevWatcher] Dev sell warning — partial sell detected', {
        mint: mint.slice(0, 8) + '...',
        soldPct: (soldPct * 100).toFixed(1) + '%',
      });

      this.emit('devSellWarning', signal);
    }
  }
}

// Singleton
const instance = new DevWatcher();
module.exports = instance;
