'use strict';

/**
 * Token Scoring System (0–100)
 *
 * Weights:
 *   Liquidity metrics     25 pts
 *   Locked liquidity      15 pts
 *   Volume quality        15 pts
 *   Holder distribution   15 pts
 *   Deployer quality      10 pts
 *   Social hype score     10 pts
 *   Narrative detection   10 pts
 *
 * Token is eligible for purchase only if score >= config.trading.minScoreToBuy
 */

const config = require('../config/config');
const { getRaydium } = require('../dex/index');
const { getLatestSocialSignal } = require('../database/db');
const logger = require('../utils/logger');

// Narrative keywords that score extra points
const BULLISH_NARRATIVES = [
  'ai', 'artificial intelligence', 'rwa', 'real world asset', 'depin', 'de-pin',
  'gaming', 'gamefi', 'nft', 'metaverse', 'meme', 'dog', 'cat', 'pepe',
  'elon', 'trump', 'biden', 'viral', 'trending',
];

class TokenScorer {
  constructor() {
    this.raydium = getRaydium();
  }

  /**
   * Calculate a comprehensive score for a token.
   *
   * @param {object} tokenInfo
   * @param {string}  tokenInfo.mint
   * @param {string}  tokenInfo.symbol
   * @param {string}  tokenInfo.name
   * @param {string}  [tokenInfo.deployer]
   * @param {number}  [tokenInfo.holderCount]
   * @param {number}  [tokenInfo.top10HolderPct]   – fraction 0–1
   * @param {number}  [tokenInfo.devWalletPct]      – fraction 0–1
   * @param {boolean} [tokenInfo.mintRenounced]
   * @param {boolean} [tokenInfo.freezeRenounced]
   * @param {number}  [tokenInfo.lockedLiqPct]      – fraction 0–1
   * @param {string}  [tokenInfo.poolId]
   * @returns {Promise<{total: number, breakdown: object, passed: boolean}>}
   */
  async score(tokenInfo) {
    const { mint, symbol = '', name = '' } = tokenInfo;
    const breakdown = {};

    // ── 1. Liquidity metrics (0–25) ──────────────────────────────────────────
    let liquidityUsd = tokenInfo.liquidityUsd;
    if (liquidityUsd === undefined) {
      liquidityUsd = await this.raydium.getLiquidityUsd(mint).catch(() => 0);
    }
    const liquidityScore = this._scoreLiquidity(liquidityUsd);
    breakdown.liquidity = { score: liquidityScore, liquidityUsd };

    // ── 2. Locked liquidity (0–15) ───────────────────────────────────────────
    let lockedPct = tokenInfo.lockedLiqPct;
    if (lockedPct === undefined && tokenInfo.poolId) {
      lockedPct = await this.raydium.getLiquidityLockFraction(tokenInfo.poolId).catch(() => 0);
    }
    lockedPct = lockedPct || 0;
    const lockedScore = this._scoreLockedLiq(lockedPct);
    breakdown.lockedLiq = { score: lockedScore, lockedPct };

    // ── 3. Volume quality (0–15) ─────────────────────────────────────────────
    let volume24h = tokenInfo.volume24h;
    if (volume24h === undefined) {
      volume24h = await this.raydium.getVolume24h(mint).catch(() => 0);
    }
    const volumeScore = this._scoreVolume(volume24h, liquidityUsd);
    breakdown.volume = { score: volumeScore, volume24h };

    // ── 4. Holder distribution (0–15) ────────────────────────────────────────
    const holderScore = this._scoreHolders({
      holderCount: tokenInfo.holderCount || 0,
      top10HolderPct: tokenInfo.top10HolderPct || 0,
      devWalletPct: tokenInfo.devWalletPct || 0,
    });
    breakdown.holders = { score: holderScore, ...tokenInfo };

    // ── 5. Deployer quality (0–10) ───────────────────────────────────────────
    const deployerScore = this._scoreDeployer({
      mintRenounced: tokenInfo.mintRenounced,
      freezeRenounced: tokenInfo.freezeRenounced,
    });
    breakdown.deployer = { score: deployerScore };

    // ── 6. Social hype (0–10) ────────────────────────────────────────────────
    const social = getLatestSocialSignal(mint);
    const socialScore = social ? Math.min(10, Math.round(social.hype_score / 10)) : 0;
    breakdown.social = { score: socialScore, hypeScore: social?.hype_score || 0 };

    // ── 7. Narrative detection (0–10) ────────────────────────────────────────
    const narrativeScore = this._scoreNarrative(symbol, name);
    breakdown.narrative = { score: narrativeScore };

    // ── Total ────────────────────────────────────────────────────────────────
    const total = Math.min(100,
      liquidityScore + lockedScore + volumeScore + holderScore +
      deployerScore + socialScore + narrativeScore
    );

    const passed = total >= config.trading.minScoreToBuy;

    logger.debug('[Scorer] Token scored', { mint, total, passed, breakdown });

    return { total, breakdown, passed };
  }

  // ─── Scoring helpers ──────────────────────────────────────────────────────

  _scoreLiquidity(usd) {
    // 0 pts < $5k, 5 pts at $5k, 15 pts at $15k, 25 pts at $50k+
    if (usd < 5_000) return 0;
    if (usd < 10_000) return 5;
    if (usd < 15_000) return 10;
    if (usd < 25_000) return 15;
    if (usd < 50_000) return 20;
    return 25;
  }

  _scoreLockedLiq(pct) {
    // 0 pts if none locked, 15 pts if ≥90% locked
    if (pct < 0.30) return 0;
    if (pct < 0.50) return 5;
    if (pct < 0.70) return 8;
    if (pct < 0.90) return 12;
    return 15;
  }

  _scoreVolume(vol24h, liq) {
    // Volume/liquidity ratio indicates organic interest
    // Also check if vol is growing (simplified: rely on caller providing vol)
    if (vol24h < 1_000) return 0;
    const ratio = liq > 0 ? vol24h / liq : 0;
    if (ratio < 0.5) return 3;
    if (ratio < 1) return 6;
    if (ratio < 3) return 10;
    if (ratio < 10) return 13;
    if (ratio < 30) return 15;
    // Extremely high ratio may indicate wash trading – cap at 8
    return 8;
  }

  _scoreHolders({ holderCount, top10HolderPct, devWalletPct }) {
    let s = 0;

    // Holder count
    if (holderCount >= 500) s += 5;
    else if (holderCount >= 200) s += 4;
    else if (holderCount >= 100) s += 3;
    else if (holderCount >= 50) s += 2;
    else s += 0;

    // Top-10 concentration (lower is better)
    if (top10HolderPct < 0.20) s += 6;
    else if (top10HolderPct < 0.30) s += 5;
    else if (top10HolderPct < 0.40) s += 3;
    else if (top10HolderPct < 0.50) s += 1;
    else s += 0;

    // Dev wallet (lower is better)
    if (devWalletPct < 0.02) s += 4;
    else if (devWalletPct < 0.05) s += 2;
    else if (devWalletPct > 0.10) s -= 3;

    return Math.max(0, Math.min(15, s));
  }

  _scoreDeployer({ mintRenounced, freezeRenounced }) {
    let s = 0;
    if (mintRenounced) s += 5;
    if (freezeRenounced) s += 5;
    return s;
  }

  _scoreNarrative(symbol = '', name = '') {
    const text = `${symbol} ${name}`.toLowerCase();
    const matched = BULLISH_NARRATIVES.filter(n => text.includes(n));
    // 2 pts per narrative keyword, max 10
    return Math.min(10, matched.length * 2);
  }
}

module.exports = TokenScorer;
