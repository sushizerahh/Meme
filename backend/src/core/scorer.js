'use strict';

/**
 * Token Scorer — Composite 0–100 scoring with adaptive weight learning
 *
 * Base weights:
 *   Liquidity          0–25 pts
 *   Locked liquidity   0–15 pts
 *   Volume quality     0–15 pts  (informed by VolumeAnalyzer)
 *   Holder distribution 0–15 pts
 *   Deployer quality   0–10 pts
 *   Social hype        0–10 pts
 *   Narrative match    0–10 pts
 *
 * Adaptive learning:
 *   After each closed trade the scorer updates per-component weights
 *   based on which components correlated with wins vs losses.
 *   Weights are persisted in the DB and loaded at startup.
 */

const config       = require('../config/config');
const { getRaydium }    = require('../dex/index');
const { getLatestSocialSignal, getDb } = require('../database/db');
const logger       = require('../utils/logger');

const BULLISH_NARRATIVES = [
  'ai', 'artificial intelligence', 'rwa', 'real world asset', 'depin',
  'gaming', 'gamefi', 'nft', 'meme', 'dog', 'cat', 'pepe', 'frog',
  'elon', 'trump', 'viral', 'trending', 'pump', 'moon', 'based',
];

// Default weights (can be adjusted by learning system)
const DEFAULT_WEIGHTS = {
  liquidity:   1.0,
  lockedLiq:   1.0,
  volume:      1.0,
  holders:     1.0,
  deployer:    1.0,
  social:      1.0,
  narrative:   1.0,
};

class TokenScorer {
  constructor() {
    this.raydium = getRaydium();
    this._weights = { ...DEFAULT_WEIGHTS };
    this._loadWeights();
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /**
   * Score a token 0–100.
   * @param {object} tokenInfo
   * @returns {Promise<{total: number, breakdown: object, passed: boolean, weights: object}>}
   */
  async score(tokenInfo) {
    const { mint, symbol = '', name = '' } = tokenInfo;
    const w = this._weights;
    const bd = {};

    // ── Liquidity (0–25 × weight) ─────────────────────────────────────────
    let liqUsd = tokenInfo.liquidityUsd;
    if (liqUsd === undefined) {
      liqUsd = await this.raydium.getLiquidityUsd(mint).catch(() => 0);
    }
    const rawLiq = this._scoreLiquidity(liqUsd);
    bd.liquidity = { raw: rawLiq, weighted: rawLiq * w.liquidity, liqUsd };

    // ── Locked liquidity (0–15 × weight) ─────────────────────────────────
    let lockedPct = tokenInfo.lockedLiqPct ?? 0;
    if (!lockedPct && tokenInfo.poolId) {
      lockedPct = await this.raydium.getLiquidityLockFraction(tokenInfo.poolId).catch(() => 0);
    }
    const rawLocked = this._scoreLockedLiq(lockedPct);
    bd.lockedLiq = { raw: rawLocked, weighted: rawLocked * w.lockedLiq, lockedPct };

    // ── Volume quality (0–15 × weight) ───────────────────────────────────
    // volumeScore may be passed in from VolumeAnalyzer (0–100); map to 0–15
    const volQuality  = tokenInfo.volumeScore ?? 100;
    const vol24h      = tokenInfo.volume24h ?? await this.raydium.getVolume24h(mint).catch(() => 0);
    const rawVol      = this._scoreVolume(vol24h, liqUsd, volQuality);
    bd.volume = { raw: rawVol, weighted: rawVol * w.volume, vol24h, volumeQuality: volQuality };

    // ── Holder distribution (0–15 × weight) ──────────────────────────────
    const rawHolders = this._scoreHolders({
      holderCount:    tokenInfo.holderCount   ?? 0,
      top10HolderPct: tokenInfo.top10HolderPct ?? 0,
      devWalletPct:   tokenInfo.devWalletPct   ?? 0,
    });
    bd.holders = { raw: rawHolders, weighted: rawHolders * w.holders };

    // ── Deployer quality (0–10 × weight) ─────────────────────────────────
    const rawDep = this._scoreDeployer(tokenInfo);
    bd.deployer  = { raw: rawDep, weighted: rawDep * w.deployer };

    // ── Social hype (0–10 × weight) ──────────────────────────────────────
    const social    = getLatestSocialSignal(mint);
    const rawSocial = social ? Math.min(10, Math.round(social.hype_score / 10)) : 0;
    bd.social = { raw: rawSocial, weighted: rawSocial * w.social, hypeScore: social?.hype_score ?? 0 };

    // ── Narrative match (0–10 × weight) ──────────────────────────────────
    const rawNarrative = this._scoreNarrative(symbol, name);
    bd.narrative = { raw: rawNarrative, weighted: rawNarrative * w.narrative };

    // ── Total (normalized back to 0–100) ─────────────────────────────────
    const weightedSum = Object.values(bd).reduce((s, c) => s + c.weighted, 0);

    // Max possible with current weights
    const maxPossible =
      25 * w.liquidity + 15 * w.lockedLiq + 15 * w.volume +
      15 * w.holders   + 10 * w.deployer  + 10 * w.social + 10 * w.narrative;

    const total  = maxPossible > 0 ? Math.min(100, Math.round(weightedSum / maxPossible * 100)) : 0;
    const passed = total >= config.trading.minScoreToBuy;

    logger.debug('[Scorer] Token scored', { mint, total, passed });

    return { total, breakdown: bd, passed, weights: { ...w } };
  }

  /**
   * Update weights based on trade outcome.
   * Called by the trader after a position is closed.
   *
   * @param {object} breakdown  – score breakdown from the original score() call
   * @param {boolean} isWin
   */
  updateWeightsFromOutcome(breakdown, isWin) {
    if (!breakdown) return;

    const LEARNING_RATE = 0.05;
    const direction     = isWin ? 1 : -1;

    // Identify which components had above/below-average raw scores
    const components = ['liquidity', 'lockedLiq', 'volume', 'holders', 'deployer', 'social', 'narrative'];
    const avgRaw = components.reduce((s, k) => s + (breakdown[k]?.raw ?? 0), 0) / components.length;

    for (const key of components) {
      const raw = breakdown[key]?.raw ?? 0;
      // If component was above-average and we won, increase its weight
      // If component was above-average and we lost, decrease its weight
      const aboveAvg = raw > avgRaw ? 1 : -1;
      const delta    = LEARNING_RATE * direction * aboveAvg;

      this._weights[key] = Math.max(0.3, Math.min(2.0, this._weights[key] + delta));
    }

    this._persistWeights();
    logger.debug('[Scorer] Weights updated', { isWin, weights: this._weights });
  }

  getWeights() {
    return { ...this._weights };
  }

  resetWeights() {
    this._weights = { ...DEFAULT_WEIGHTS };
    this._persistWeights();
  }

  // ── Scoring functions ─────────────────────────────────────────────────────

  _scoreLiquidity(usd) {
    if (usd < 5_000)  return 0;
    if (usd < 10_000) return 5;
    if (usd < 15_000) return 10;
    if (usd < 25_000) return 15;
    if (usd < 50_000) return 20;
    return 25;
  }

  _scoreLockedLiq(pct) {
    if (pct < 0.30) return 0;
    if (pct < 0.50) return 5;
    if (pct < 0.70) return 8;
    if (pct < 0.90) return 12;
    return 15;
  }

  _scoreVolume(vol24h, liq, qualityScore) {
    // qualityScore (0–100) from VolumeAnalyzer: penalise fake volume
    const qualityMul = qualityScore / 100;

    if (vol24h < 1_000)  return 0;
    const ratio = liq > 0 ? vol24h / liq : 0;

    let base;
    if (ratio < 0.5)  base = 3;
    else if (ratio < 1)   base = 6;
    else if (ratio < 3)   base = 10;
    else if (ratio < 10)  base = 13;
    else if (ratio < 30)  base = 15;
    else base = 8; // very high ratio = suspicious

    return Math.round(base * qualityMul);
  }

  _scoreHolders({ holderCount, top10HolderPct, devWalletPct }) {
    let s = 0;
    if      (holderCount >= 500) s += 5;
    else if (holderCount >= 200) s += 4;
    else if (holderCount >= 100) s += 3;
    else if (holderCount >= 50)  s += 2;

    if      (top10HolderPct < 0.20) s += 6;
    else if (top10HolderPct < 0.30) s += 5;
    else if (top10HolderPct < 0.40) s += 3;
    else if (top10HolderPct < 0.50) s += 1;

    if      (devWalletPct < 0.02) s += 4;
    else if (devWalletPct < 0.05) s += 2;
    else if (devWalletPct > 0.10) s -= 3;

    return Math.max(0, Math.min(15, s));
  }

  _scoreDeployer({ mintRenounced, freezeRenounced }) {
    return (mintRenounced ? 5 : 0) + (freezeRenounced ? 5 : 0);
  }

  _scoreNarrative(symbol = '', name = '') {
    const text    = `${symbol} ${name}`.toLowerCase();
    const matched = BULLISH_NARRATIVES.filter(n => text.includes(n));
    return Math.min(10, matched.length * 2);
  }

  // ── Weight persistence ────────────────────────────────────────────────────

  _loadWeights() {
    try {
      const db  = getDb();
      const row = db.prepare("SELECT data FROM events WHERE type = 'scorer_weights' ORDER BY ts DESC LIMIT 1").get();
      if (row) {
        const saved = JSON.parse(row.data);
        this._weights = { ...DEFAULT_WEIGHTS, ...saved };
        logger.debug('[Scorer] Loaded adaptive weights', this._weights);
      }
    } catch { /* use defaults */ }
  }

  _persistWeights() {
    try {
      const db = getDb();
      db.prepare("INSERT INTO events (type, data) VALUES ('scorer_weights', ?)").run(JSON.stringify(this._weights));
    } catch { /* non-fatal */ }
  }
}

module.exports = TokenScorer;
