'use strict';

/**
 * Risk Management Module
 *
 * Responsibilities:
 *   • Calculate position size (1–3% of balance)
 *   • Track daily P&L and enforce daily loss limit
 *   • Count consecutive losses → auto-halt
 *   • Emergency stop toggle
 *   • Pre-trade capital checks
 */

const config = require('../config/config');
const { getDailyStats, updateDailyStats, logEvent } = require('../database/db');
const { getConnection } = require('../dex/index');
const { LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const logger = require('../utils/logger');

class RiskManager {
  constructor() {
    this._consecutiveLosses = 0;
    this._haltedUntil = null;
    this._startingDailyBalance = null;
    this._emergencyStop = false;
  }

  /**
   * Check if trading is currently allowed.
   * @returns {{ allowed: boolean, reason: string }}
   */
  canTrade() {
    if (this._emergencyStop || config.risk.emergencyStop) {
      return { allowed: false, reason: 'Emergency stop active' };
    }
    if (this._haltedUntil && Date.now() < this._haltedUntil) {
      const mins = Math.ceil((this._haltedUntil - Date.now()) / 60_000);
      return { allowed: false, reason: `Auto-halted – ${mins}min remaining` };
    }
    if (this._consecutiveLosses >= config.risk.maxConsecutiveLosses) {
      const pauseMs = config.risk.pauseAfterLossHours * 3_600_000;
      this._haltedUntil = Date.now() + pauseMs;
      this._consecutiveLosses = 0;
      logger.warn('[Risk] Auto-halt triggered after consecutive losses', {
        hours: config.risk.pauseAfterLossHours,
      });
      logEvent('risk_halt', { reason: 'consecutive_losses', pauseMs });
      return { allowed: false, reason: `Halted for ${config.risk.pauseAfterLossHours}h – consecutive losses` };
    }
    return { allowed: true, reason: 'OK' };
  }

  /**
   * Calculate position size in SOL for the next trade.
   * @param {string} walletAddress – base58 public key
   * @param {number} [forcePct]    – override fraction (optional)
   * @returns {Promise<number>} SOL amount to trade
   */
  async calcPositionSize(walletAddress, forcePct) {
    const balance = await this._getBalance(walletAddress);
    const pct = forcePct
      ? Math.min(Math.max(forcePct, config.trading.minTradeCapitalPct), config.trading.maxTradeCapitalPct)
      : config.trading.tradeCapitalPct;

    const size = balance * pct;
    logger.debug('[Risk] Position size calculated', { balance, pct, size });
    return size;
  }

  /**
   * Check if today's loss limit has been reached.
   * @param {string} walletAddress
   * @returns {Promise<boolean>}
   */
  async isDailyLossLimitHit(walletAddress) {
    const today = new Date().toISOString().slice(0, 10);
    const stats = getDailyStats(today);

    if (!this._startingDailyBalance) {
      this._startingDailyBalance = await this._getBalance(walletAddress);
    }

    const maxLoss = this._startingDailyBalance * config.risk.maxDailyLossPct;
    const todayLoss = -(stats.total_pnl_sol || 0);

    if (todayLoss >= maxLoss) {
      logger.warn('[Risk] Daily loss limit reached', { todayLoss, maxLoss });
      logEvent('daily_loss_limit', { todayLoss, maxLoss });
      return true;
    }
    return false;
  }

  /**
   * Record the result of a closed trade.
   * @param {number} pnlSol  – positive = win, negative = loss
   */
  recordTradeResult(pnlSol) {
    const today = new Date().toISOString().slice(0, 10);
    const isWin = pnlSol > 0;

    updateDailyStats(today, {
      trades: 1,
      wins: isWin ? 1 : 0,
      losses: isWin ? 0 : 1,
      total_pnl_sol: pnlSol,
    });

    if (isWin) {
      this._consecutiveLosses = 0;
    } else {
      this._consecutiveLosses += 1;
      logger.info('[Risk] Consecutive losses', { count: this._consecutiveLosses });
    }
  }

  /**
   * Calculate initial stop loss price.
   * @param {number} entryPrice
   * @returns {number} stop loss price
   */
  calcStopLoss(entryPrice) {
    return entryPrice * (1 - config.trading.stopLossPct);
  }

  /**
   * Update trailing stop given current price and previous trailing stop.
   * @param {number} entryPrice
   * @param {number} currentPrice
   * @param {number} currentTrailingStop
   * @returns {number} new trailing stop price
   */
  updateTrailingStop(entryPrice, currentPrice, currentTrailingStop) {
    const gainPct = (currentPrice - entryPrice) / entryPrice;
    if (gainPct < config.trading.trailingStopActivatePct) {
      return currentTrailingStop; // not activated yet
    }
    const newStop = currentPrice * (1 - config.trading.trailingStopPct);
    return Math.max(newStop, currentTrailingStop); // only move up
  }

  /**
   * Toggle emergency stop.
   */
  setEmergencyStop(active) {
    this._emergencyStop = active;
    config.risk.emergencyStop = active;
    logger.warn('[Risk] Emergency stop', { active });
    logEvent('emergency_stop', { active });
  }

  isEmergencyStop() {
    return this._emergencyStop || config.risk.emergencyStop;
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  async _getBalance(walletAddress) {
    try {
      const lamports = await getConnection().getBalance(new PublicKey(walletAddress));
      return lamports / LAMPORTS_PER_SOL;
    } catch {
      return 0;
    }
  }
}

module.exports = RiskManager;
