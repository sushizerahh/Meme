'use strict';

/**
 * Risk Manager — Capital protection & market-condition awareness
 *
 * Responsibilities:
 *   • Position sizing (1–3% of wallet balance)
 *   • Daily loss limit enforcement
 *   • Consecutive-loss auto-halt
 *   • Emergency stop toggle
 *   • Market condition monitor (auto-pause when market is bad)
 *   • Pre-trade capital check
 *
 * Market condition detection:
 *   Tracks the bot's recent trade outcomes and computes a "market health"
 *   score. When win rate drops below threshold over a rolling window,
 *   the bot pauses automatically to avoid trading in an adverse environment.
 */

const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const config  = require('../config/config');
const { getDailyStats, updateDailyStats, getDb, logEvent } = require('../database/db');
const { getConnection } = require('../dex/index');
const logger  = require('../utils/logger');

// Market health: rolling window size (trade count)
const MARKET_HEALTH_WINDOW  = 10;
const MARKET_HEALTH_MIN_WIN  = 0.35;  // pause if win rate < 35% over last 10 trades
const MARKET_HEALTH_RESTORE  = 0.50;  // resume when it recovers to 50%+

class RiskManager {
  constructor() {
    this._consecutiveLosses    = 0;
    this._haltedUntil          = null;
    this._emergencyStop        = false;
    this._startingDailyBalance = null;
    this._marketPaused         = false;
    this._recentOutcomes       = [];   // true = win, false = loss (last N)
  }

  // ── Trade allowance ────────────────────────────────────────────────────────

  /**
   * Check if a new trade is allowed right now.
   * @returns {{ allowed: boolean, reason: string }}
   */
  canTrade() {
    if (this._emergencyStop || config.risk.emergencyStop) {
      return { allowed: false, reason: 'Emergency stop active' };
    }

    if (this._haltedUntil && Date.now() < this._haltedUntil) {
      const mins = Math.ceil((this._haltedUntil - Date.now()) / 60_000);
      return { allowed: false, reason: `Auto-halted — ${mins}min remaining after consecutive losses` };
    }

    // Reset halt after cooldown expires
    if (this._haltedUntil && Date.now() >= this._haltedUntil) {
      this._haltedUntil = null;
      this._consecutiveLosses = 0;
      logger.info('[Risk] Auto-halt lifted — resuming trading');
    }

    if (this._consecutiveLosses >= config.risk.maxConsecutiveLosses) {
      this._triggerAutoHalt('consecutive_losses');
      return { allowed: false, reason: `Halted ${config.risk.pauseAfterLossHours}h after ${this._consecutiveLosses} consecutive losses` };
    }

    if (this._marketPaused) {
      return { allowed: false, reason: 'Market conditions poor — auto-paused (win rate too low)' };
    }

    return { allowed: true, reason: 'OK' };
  }

  // ── Position sizing ────────────────────────────────────────────────────────

  /**
   * Calculate SOL amount for next trade.
   * Scales DOWN if recent win rate is declining (Kelly-inspired).
   * @param {string} walletAddress
   * @param {number} [forcePct]
   */
  async calcPositionSize(walletAddress, forcePct) {
    const balance = await this._getBalance(walletAddress);
    let pct = forcePct ?? config.trading.tradeCapitalPct;

    // Scale down if recent performance is weak
    const recentWinRate = this._recentWinRate();
    if (recentWinRate !== null && recentWinRate < 0.50 && !forcePct) {
      const scaleFactor = Math.max(0.5, recentWinRate / 0.60);
      pct = pct * scaleFactor;
      logger.debug('[Risk] Scaling down position size', { recentWinRate, scaleFactor, pct });
    }

    pct = Math.min(Math.max(pct, config.trading.minTradeCapitalPct), config.trading.maxTradeCapitalPct);
    const size = balance * pct;

    logger.debug('[Risk] Position size', { balance, pct: (pct * 100).toFixed(1) + '%', size });
    return size;
  }

  // ── Loss tracking ──────────────────────────────────────────────────────────

  /**
   * Record outcome of a closed trade.
   * @param {number} pnlSol  – positive = win, negative = loss
   */
  recordTradeResult(pnlSol) {
    const today = new Date().toISOString().slice(0, 10);
    const isWin = pnlSol > 0;

    updateDailyStats(today, {
      trades:        1,
      wins:          isWin ? 1 : 0,
      losses:        isWin ? 0 : 1,
      total_pnl_sol: pnlSol,
    });

    // Update consecutive loss counter
    if (isWin) {
      this._consecutiveLosses = 0;
    } else {
      this._consecutiveLosses += 1;
      logger.info('[Risk] Consecutive losses', { count: this._consecutiveLosses });
    }

    // Update rolling market health window
    this._recentOutcomes.push(isWin);
    if (this._recentOutcomes.length > MARKET_HEALTH_WINDOW) {
      this._recentOutcomes.shift();
    }

    // Evaluate market condition
    this._evaluateMarketHealth();
  }

  /**
   * Check if today's daily loss limit is reached.
   */
  async isDailyLossLimitHit(walletAddress) {
    const today = new Date().toISOString().slice(0, 10);
    const stats = getDailyStats(today);

    if (!this._startingDailyBalance) {
      this._startingDailyBalance = await this._getBalance(walletAddress);
    }

    const maxLoss  = this._startingDailyBalance * config.risk.maxDailyLossPct;
    const todayLoss = -(stats.total_pnl_sol || 0);

    if (todayLoss >= maxLoss) {
      logger.warn('[Risk] Daily loss limit reached', { todayLoss: todayLoss.toFixed(4), maxLoss: maxLoss.toFixed(4) });
      logEvent('daily_loss_limit', { todayLoss, maxLoss });
      return true;
    }
    return false;
  }

  // ── Stop calculations ──────────────────────────────────────────────────────

  calcStopLoss(entryPrice) {
    return entryPrice * (1 - config.trading.stopLossPct);
  }

  updateTrailingStop(entryPrice, currentPrice, currentTrailingStop) {
    const gainPct = (currentPrice - entryPrice) / entryPrice;
    if (gainPct < config.trading.trailingStopActivatePct) return currentTrailingStop;
    const newStop = currentPrice * (1 - config.trading.trailingStopPct);
    return Math.max(newStop, currentTrailingStop);
  }

  // ── Emergency & manual controls ───────────────────────────────────────────

  setEmergencyStop(active) {
    this._emergencyStop          = active;
    config.risk.emergencyStop    = active;
    logger.warn('[Risk] Emergency stop', { active });
    logEvent('emergency_stop', { active });
  }

  isEmergencyStop() {
    return this._emergencyStop || config.risk.emergencyStop;
  }

  getState() {
    return {
      emergencyStop:      this._emergencyStop,
      consecutiveLosses:  this._consecutiveLosses,
      haltedUntil:        this._haltedUntil,
      marketPaused:       this._marketPaused,
      recentWinRate:      this._recentWinRate(),
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  async _getBalance(walletAddress) {
    try {
      const lamports = await getConnection().getBalance(new PublicKey(walletAddress));
      return lamports / LAMPORTS_PER_SOL;
    } catch { return 0; }
  }

  _recentWinRate() {
    if (this._recentOutcomes.length < 3) return null;
    const wins = this._recentOutcomes.filter(Boolean).length;
    return wins / this._recentOutcomes.length;
  }

  _evaluateMarketHealth() {
    if (this._recentOutcomes.length < MARKET_HEALTH_WINDOW) return;

    const winRate = this._recentWinRate();

    if (!this._marketPaused && winRate < MARKET_HEALTH_MIN_WIN) {
      this._marketPaused = true;
      logger.warn('[Risk] Market health poor — auto-pausing', {
        winRate: (winRate * 100).toFixed(0) + '%',
        window: MARKET_HEALTH_WINDOW,
      });
      logEvent('market_pause', { winRate });
    } else if (this._marketPaused && winRate >= MARKET_HEALTH_RESTORE) {
      this._marketPaused = false;
      logger.info('[Risk] Market health recovered — resuming', {
        winRate: (winRate * 100).toFixed(0) + '%',
      });
      logEvent('market_resume', { winRate });
    }
  }

  _triggerAutoHalt(reason) {
    if (this._haltedUntil) return; // already halted
    const pauseMs = config.risk.pauseAfterLossHours * 3_600_000;
    this._haltedUntil = Date.now() + pauseMs;
    logger.warn('[Risk] Auto-halt triggered', { reason, pauseHours: config.risk.pauseAfterLossHours });
    logEvent('risk_halt', { reason, pauseMs });
  }
}

module.exports = RiskManager;
