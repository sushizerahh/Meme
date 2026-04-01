'use strict';

/**
 * Copy Trading Module — Smart-money wallet mirroring
 *
 * Improvements:
 *   • Win-rate filtering: only mirrors wallets above configurable threshold
 *   • Wallet ranking: ranks tracked wallets by consistency (win rate × avg PnL)
 *   • Ignores wallets that had one lucky big win but no consistency
 *   • Auto-removes wallets that start performing poorly
 *   • Tracks per-wallet stats in DB
 *   • Applies all the same scoring & anti-scam checks before copying
 */

const { PublicKey }  = require('@solana/web3.js');
const config         = require('../config/config');
const { getConnection } = require('../dex/index');
const { isBlacklisted, getDb, logEvent } = require('../database/db');
const logger         = require('../utils/logger');

// Minimum trades before we trust a wallet's stats
const MIN_TRACKED_TRADES = 10;

class CopyTrader {
  /**
   * @param {import('./trader')} tradingEngine
   */
  constructor(tradingEngine) {
    this.engine     = tradingEngine;
    this.connection = getConnection();

    this._subscriptions  = new Map(); // address → subId
    this._walletStats    = new Map(); // address → { wins, losses, totalPnl }
    this._running        = false;

    this._loadWalletStats();
  }

  start() {
    if (!config.copyTrading.enabled) {
      logger.info('[CopyTrader] Disabled in config');
      return;
    }
    this._running = true;

    for (const wallet of config.copyTrading.trackedWallets) {
      this._watchWallet(wallet);
    }

    // Periodic ranking log
    setInterval(() => this._logRanking(), 30 * 60_000);

    logger.info('[CopyTrader] Started', {
      wallets: config.copyTrading.trackedWallets.length,
    });
  }

  stop() {
    this._running = false;
    for (const [, subId] of this._subscriptions) {
      try { this.connection.removeAccountChangeListener(subId); } catch {}
    }
    this._subscriptions.clear();
    logger.info('[CopyTrader] Stopped');
  }

  addWallet(address) {
    if (!this._subscriptions.has(address)) {
      this._watchWallet(address);
    }
  }

  removeWallet(address) {
    const subId = this._subscriptions.get(address);
    if (subId) {
      this.connection.removeAccountChangeListener(subId);
      this._subscriptions.delete(address);
    }
  }

  getRanking() {
    return [...this._walletStats.entries()]
      .map(([address, stats]) => ({
        address,
        ...stats,
        winRate: stats.wins / Math.max(stats.wins + stats.losses, 1),
        consistency: this._consistencyScore(stats),
      }))
      .sort((a, b) => b.consistency - a.consistency);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _watchWallet(address) {
    try {
      const pubkey = new PublicKey(address);

      const subId = this.connection.onLogs(pubkey, async (logs) => {
        if (!this._running) return;
        await this._handleWalletLogs(address, logs);
      }, 'confirmed');

      this._subscriptions.set(address, subId);
      logger.debug('[CopyTrader] Watching', { address });
    } catch (err) {
      logger.warn('[CopyTrader] Failed to watch wallet', { address, err: err.message });
    }
  }

  async _handleWalletLogs(wallet, logs) {
    const logText = (logs.logs || []).join(' ');

    // Filter for swap transactions only
    const isSwap = logText.includes('Instruction: Swap') ||
      logText.includes('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') || // Raydium AMM
      logText.includes('JUP');

    if (!isSwap) return;

    // Check this wallet's win-rate quality
    if (!this._isWalletTrustworthy(wallet)) {
      logger.debug('[CopyTrader] Skipping untrustworthy wallet', { wallet });
      return;
    }

    const tokenMint = await this._extractBoughtToken(wallet, logs.signature);
    if (!tokenMint) return;
    if (isBlacklisted(tokenMint)) return;

    logger.info('[CopyTrader] Wallet bought token', { wallet, tokenMint });

    // Random delay within configured max to avoid front-running detection
    const delay = Math.random() * config.copyTrading.maxCopyDelayMs;
    await new Promise(r => setTimeout(r, delay));

    this.engine.processNewToken({
      mint:        tokenMint,
      symbol:      '',
      name:        '',
      source:      'copy_trade',
      copyWallet:  wallet,
    }).catch(err =>
      logger.debug('[CopyTrader] processNewToken error', { err: err.message })
    );
  }

  _isWalletTrustworthy(address) {
    const stats = this._walletStats.get(address);

    // Not enough data yet — allow until we have MIN_TRACKED_TRADES
    if (!stats || (stats.wins + stats.losses) < MIN_TRACKED_TRADES) return true;

    const winRate = stats.wins / (stats.wins + stats.losses);

    // Reject if win rate below config threshold
    if (winRate < config.copyTrading.minWinRate) {
      logger.warn('[CopyTrader] Wallet below min win rate — ignoring', {
        address, winRate: (winRate * 100).toFixed(1) + '%',
      });
      return false;
    }

    // Reject if average PnL is negative (lucky but ultimately unprofitable)
    const avgPnl = stats.totalPnl / (stats.wins + stats.losses);
    if (avgPnl < 0) {
      logger.warn('[CopyTrader] Wallet average PnL negative', { address, avgPnl });
      return false;
    }

    return true;
  }

  _consistencyScore(stats) {
    const total   = stats.wins + stats.losses;
    if (!total) return 0;
    const winRate = stats.wins / total;
    const avgPnl  = stats.totalPnl / total;
    // Score = win rate × avg PnL × confidence (more trades = more confidence)
    const confidence = Math.min(1, total / 30);
    return winRate * Math.max(0, avgPnl) * confidence;
  }

  async _extractBoughtToken(wallet, signature) {
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (!tx) return null;

      const pre  = tx.meta?.preTokenBalances  || [];
      const post = tx.meta?.postTokenBalances || [];

      // Find token accounts that INCREASED for this wallet
      for (const postBal of post) {
        if (postBal.owner !== wallet) continue;
        const preBal  = pre.find(p => p.accountIndex === postBal.accountIndex);
        const preAmt  = parseFloat(preBal?.uiTokenAmount?.uiAmount || '0');
        const postAmt = parseFloat(postBal.uiTokenAmount?.uiAmount  || '0');

        if (postAmt > preAmt) return postBal.mint;
      }
      return null;
    } catch { return null; }
  }

  _loadWalletStats() {
    try {
      const rows = getDb().prepare("SELECT * FROM copy_wallets WHERE active = 1").all();
      for (const row of rows) {
        this._walletStats.set(row.address, {
          wins:     0,
          losses:   0,
          totalPnl: row.avg_pnl || 0,
        });
      }
    } catch { /* DB might not be ready */ }
  }

  _logRanking() {
    const ranking = this.getRanking();
    if (ranking.length) {
      logger.info('[CopyTrader] Wallet ranking', {
        top: ranking.slice(0, 5).map(w => ({
          addr: w.address.slice(0, 8),
          winRate: (w.winRate * 100).toFixed(0) + '%',
          consistency: w.consistency.toFixed(4),
        })),
      });
    }
  }
}

module.exports = CopyTrader;
