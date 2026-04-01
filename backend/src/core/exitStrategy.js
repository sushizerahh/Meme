'use strict';

/**
 * Exit Strategy Module
 *
 * All position exit logic lives here. The trading engine calls
 * `evaluate(position, currentPrice, poolInfo)` on every monitoring tick.
 *
 * Exit triggers (in priority order):
 *   1. Emergency stop            → sell 100%
 *   2. Stop loss hit             → sell 100%
 *   3. Trailing stop hit         → sell remaining
 *   4. Take-profit level reached → partial sell
 *   5. Liquidity collapse        → sell remaining
 *   6. Volume collapse           → sell remaining
 *   7. Price stagnation          → sell remaining (optional)
 *
 * The module is stateless — it never modifies positions directly.
 * Instead it returns an ExitSignal that the trader executes.
 */

const config      = require('../config/config');
const { getRaydium } = require('../dex/index');
const logger      = require('../utils/logger');

/** @typedef {{ trigger: string, sellPct: number, urgency: 'normal'|'fast'|'emergency' }} ExitSignal */

class ExitStrategy {
  constructor(riskManager) {
    this.risk    = riskManager;
    this.raydium = getRaydium();
  }

  /**
   * Evaluate whether a position should be exited (partially or fully).
   *
   * @param {object} position    – DB position row
   * @param {number} currentPrice
   * @param {object} [poolInfo]  – optional pre-fetched Raydium pool data
   * @returns {Promise<ExitSignal|null>}  null = hold
   */
  async evaluate(position, currentPrice, poolInfo = null) {
    const {
      entry_price, stop_loss, trailing_stop,
      remaining_pct, tp_levels_sold = 0,
    } = position;

    // ── 1. Emergency stop ──────────────────────────────────────────────────
    if (this.risk.isEmergencyStop()) {
      return { trigger: 'emergency', sellPct: remaining_pct, urgency: 'emergency' };
    }

    // ── 2. Hard stop loss ─────────────────────────────────────────────────
    if (currentPrice <= stop_loss) {
      logger.warn('[Exit] Stop loss triggered', {
        mint: position.mint, currentPrice, stop_loss, pnlPct: this._pnlPct(entry_price, currentPrice),
      });
      return { trigger: 'stop_loss', sellPct: remaining_pct, urgency: 'fast' };
    }

    // ── 3. Trailing stop ──────────────────────────────────────────────────
    const gainPct = (currentPrice - entry_price) / entry_price;
    const newTrailingStop = this._calcTrailingStop(entry_price, currentPrice, trailing_stop);

    if (gainPct >= config.trading.trailingStopActivatePct && currentPrice <= newTrailingStop) {
      logger.info('[Exit] Trailing stop triggered', {
        mint: position.mint, currentPrice, trailingStop: newTrailingStop,
      });
      return { trigger: 'trailing_stop', sellPct: remaining_pct, urgency: 'fast', newTrailingStop };
    }

    // ── 4. Take-profit levels (partial sells) ─────────────────────────────
    const tpSignal = this._checkTakeProfitLevels(position, gainPct);
    if (tpSignal) return { ...tpSignal, newTrailingStop };

    // ── 5. Fundamental exits (check pool state) ───────────────────────────
    const pool = poolInfo || await this.raydium.getPoolInfo(position.mint).catch(() => null);
    if (pool) {
      const fundSignal = await this._checkFundamentalExits(position, currentPrice, pool);
      if (fundSignal) return { ...fundSignal, newTrailingStop };
    }

    // ── HOLD ──────────────────────────────────────────────────────────────
    // Return updated trailing stop even on hold so caller can persist it
    return newTrailingStop !== trailing_stop
      ? { trigger: 'hold', sellPct: 0, urgency: 'normal', newTrailingStop }
      : null;
  }

  /**
   * Calculate initial stop loss price for a new position.
   */
  calcInitialStopLoss(entryPrice) {
    return entryPrice * (1 - config.trading.stopLossPct);
  }

  /**
   * Recalculate trailing stop (one-way ratchet — only moves up).
   */
  calcUpdatedTrailingStop(entryPrice, currentPrice, currentTrailingStop) {
    return this._calcTrailingStop(entryPrice, currentPrice, currentTrailingStop);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _calcTrailingStop(entryPrice, currentPrice, currentTrailingStop) {
    const gainPct = (currentPrice - entryPrice) / entryPrice;
    if (gainPct < config.trading.trailingStopActivatePct) {
      return currentTrailingStop; // not activated yet
    }
    const newStop = currentPrice * (1 - config.trading.trailingStopPct);
    return Math.max(newStop, currentTrailingStop); // only ratchet up
  }

  _checkTakeProfitLevels(position, gainPct) {
    const { remaining_pct } = position;
    if (remaining_pct <= 0.05) return null; // nothing left to sell

    for (let i = 0; i < config.trading.takeProfitLevels.length; i++) {
      const tp       = config.trading.takeProfitLevels[i];
      const soldKey  = `tp_${i}_sold`;

      if (position[soldKey]) continue;           // already executed this level
      if (gainPct < tp.targetMul - 1) continue;  // price not there yet

      const sellPct = Math.min(tp.pct, remaining_pct);
      logger.info('[Exit] Take-profit triggered', {
        mint: position.mint, level: i, gainPct: (gainPct * 100).toFixed(1), sellPct,
      });
      return {
        trigger: `take_profit_${i}`,
        sellPct,
        urgency: 'normal',
        tpLevelIndex: i,
        remainingAfter: remaining_pct - sellPct,
      };
    }
    return null;
  }

  async _checkFundamentalExits(position, currentPrice, pool) {
    const { mint, entry_price, remaining_pct, entry_liq_usd } = position;
    const currentLiq = pool.tvl || 0;

    // ── Liquidity collapse: dropped > 60% from entry liquidity ───────────
    if (entry_liq_usd && currentLiq < entry_liq_usd * 0.40) {
      logger.warn('[Exit] Liquidity collapse', {
        mint, currentLiq, entryLiq: entry_liq_usd,
        dropPct: ((1 - currentLiq / entry_liq_usd) * 100).toFixed(1),
      });
      return { trigger: 'liquidity_collapse', sellPct: remaining_pct, urgency: 'fast' };
    }

    // ── Liquidity below absolute minimum ─────────────────────────────────
    if (currentLiq < config.filters.minLiquidityUsd * 0.5) {
      logger.warn('[Exit] Liquidity below minimum', { mint, currentLiq });
      return { trigger: 'liquidity_drop', sellPct: remaining_pct, urgency: 'fast' };
    }

    // ── Volume collapse: volume almost zero while price declining ─────────
    const vol = pool.volume24h || 0;
    const liq = pool.tvl       || 1;
    const gainPct = (currentPrice - entry_price) / entry_price;

    if (vol < liq * 0.02 && gainPct < -0.10) {
      logger.info('[Exit] Volume collapse + declining price', { mint, vol, liq, gainPct });
      return { trigger: 'volume_collapse', sellPct: remaining_pct, urgency: 'normal' };
    }

    // ── Price stagnation at loss: held too long with no recovery ──────────
    const heldSeconds = Math.floor(Date.now() / 1000) - (position.open_ts || 0);
    if (heldSeconds > 1800 && gainPct < -0.05) {  // 30min+ underwater
      return { trigger: 'stagnation', sellPct: remaining_pct, urgency: 'normal' };
    }

    return null;
  }

  _pnlPct(entry, current) {
    return ((current - entry) / entry * 100).toFixed(1) + '%';
  }
}

module.exports = ExitStrategy;
