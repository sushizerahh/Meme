'use strict';

/**
 * Decision Engine — Central buy/no-buy arbiter
 *
 * Every potential trade flows through here. No buy happens without
 * this module's explicit approval. It aggregates:
 *
 *   1. Anti-scam filters       (hard gate: FAIL = instant reject)
 *   2. Token scoring            (0–100 composite score)
 *   3. Volume quality           (fake volume detection)
 *   4. Risk manager             (daily loss, consecutive losses, balance)
 *   5. Market condition         (pause in bad market)
 *   6. Entry confirmation       (verify liquidity still valid post-delay)
 *
 * Decision: BUY | SKIP | DEFER (retry later) | HALT
 *
 * Also handles the intelligent sniper delay (10–30s) and re-validation
 * after the delay to confirm the opportunity is still valid.
 */

const config         = require('../config/config');
const AntiScamFilter = require('../filters/antiscam');
const TokenScorer    = require('./scorer');
const volumeAnalyzer = require('./volumeAnalyzer');
const { getRaydium } = require('../dex/index');
const { isBlacklisted, getOpenPositions, logEvent } = require('../database/db');
const logger         = require('../utils/logger');

/** Decision outcomes */
const DECISION = {
  BUY:   'BUY',
  SKIP:  'SKIP',   // permanent rejection
  DEFER: 'DEFER',  // re-check later
  HALT:  'HALT',   // system-level halt (emergency/risk limit)
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

class DecisionEngine {
  constructor(riskManager) {
    this.risk      = riskManager;
    this.antiscam  = new AntiScamFilter();
    this.scorer    = new TokenScorer();
    this.raydium   = getRaydium();
  }

  /**
   * Full decision pipeline for a newly detected token.
   * Includes the intelligent sniper delay.
   *
   * @param {object} tokenInfo  – enriched token metadata from Scanner
   * @returns {Promise<{decision: string, reason: string, score: object|null}>}
   */
  async evaluate(tokenInfo) {
    const { mint } = tokenInfo;

    logger.debug('[Decision] Evaluating token', { mint, symbol: tokenInfo.symbol });

    // ── GATE 1: System-level checks (instant) ─────────────────────────────
    const systemCheck = this._checkSystemGates();
    if (systemCheck.halt) {
      return { decision: DECISION.HALT, reason: systemCheck.reason, score: null };
    }

    // ── GATE 2: Blacklist (instant) ───────────────────────────────────────
    if (isBlacklisted(mint)) {
      return { decision: DECISION.SKIP, reason: 'Blacklisted contract', score: null };
    }
    if (tokenInfo.deployer && isBlacklisted(tokenInfo.deployer)) {
      return { decision: DECISION.SKIP, reason: 'Blacklisted deployer', score: null };
    }

    // ── GATE 3: Open position limit ───────────────────────────────────────
    const open = getOpenPositions();
    if (open.length >= config.trading.maxPositions) {
      return { decision: DECISION.DEFER, reason: `Max positions (${config.trading.maxPositions}) reached`, score: null };
    }

    // ── GATE 4: Risk checks ───────────────────────────────────────────────
    const riskCheck = this.risk.canTrade();
    if (!riskCheck.allowed) {
      return {
        decision: riskCheck.reason.includes('halt') ? DECISION.HALT : DECISION.DEFER,
        reason: riskCheck.reason,
        score: null,
      };
    }

    // ── GATE 5: Quick liquidity sanity (before burning time on scoring) ───
    const initialLiq = tokenInfo.liquidityUsd;
    if (initialLiq !== undefined && initialLiq < config.filters.minLiquidityUsd * 0.5) {
      return { decision: DECISION.SKIP, reason: `Liquidity too low ($${initialLiq?.toFixed(0)})`, score: null };
    }

    // ── GATE 6: Anti-scam (may take a few RPC calls) ──────────────────────
    const scam = await this.antiscam.check(tokenInfo);
    if (!scam.pass) {
      logEvent('antiscam_reject', { mint, reasons: scam.reasons });
      return {
        decision: DECISION.SKIP,
        reason: `Anti-scam: ${scam.reasons.slice(0, 2).join('; ')}`,
        score: null,
      };
    }

    // ── GATE 7: Volume quality ────────────────────────────────────────────
    const volAnalysis = await volumeAnalyzer.analyze(mint, tokenInfo.poolInfo);
    if (!volAnalysis.organic) {
      return {
        decision: DECISION.SKIP,
        reason: `Fake volume detected: ${volAnalysis.flags[0]}`,
        score: null,
      };
    }

    // ── GATE 8: Score (compute full composite score) ──────────────────────
    const scoreResult = await this.scorer.score({
      ...tokenInfo,
      volumeScore: volAnalysis.score,
    });

    if (!scoreResult.passed) {
      return {
        decision: DECISION.SKIP,
        reason: `Score ${scoreResult.total} < threshold ${config.trading.minScoreToBuy}`,
        score: scoreResult,
      };
    }

    // ── DELAY: Intelligent sniper delay (10–30s) ──────────────────────────
    const delayMs = this._calcDelay(scoreResult.total);
    logger.info('[Decision] Applying sniper delay', {
      mint, symbol: tokenInfo.symbol,
      score: scoreResult.total, delayMs,
    });
    await sleep(delayMs);

    // ── GATE 9: Post-delay re-validation ─────────────────────────────────
    // Re-check all system gates after delay (things can change in 10–30s)
    const postDelayCheck = await this._postDelayValidation(mint, tokenInfo);
    if (!postDelayCheck.ok) {
      return { decision: DECISION.SKIP, reason: `Post-delay fail: ${postDelayCheck.reason}`, score: scoreResult };
    }

    // ── APPROVED ──────────────────────────────────────────────────────────
    logger.info('[Decision] BUY approved', {
      mint,
      symbol: tokenInfo.symbol,
      score: scoreResult.total,
      delayMs,
      liquidityUsd: postDelayCheck.liquidityUsd,
    });

    return {
      decision: DECISION.BUY,
      reason: `Score ${scoreResult.total}, liq $${postDelayCheck.liquidityUsd?.toFixed(0)}`,
      score: scoreResult,
      liquidityUsd: postDelayCheck.liquidityUsd,
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _checkSystemGates() {
    if (this.risk.isEmergencyStop()) {
      return { halt: true, reason: 'Emergency stop active' };
    }
    const rc = this.risk.canTrade();
    if (!rc.allowed && rc.reason.toLowerCase().includes('halt')) {
      return { halt: true, reason: rc.reason };
    }
    return { halt: false };
  }

  /**
   * After the sniper delay, re-confirm:
   *   • Risk gates still pass
   *   • Liquidity still meets minimum
   *   • Volume still growing (not dumping)
   *   • Position slots still available
   */
  async _postDelayValidation(mint, originalTokenInfo) {
    // System & risk
    const rc = this.risk.canTrade();
    if (!rc.allowed) return { ok: false, reason: rc.reason };

    const open = getOpenPositions();
    if (open.length >= config.trading.maxPositions) {
      return { ok: false, reason: 'Max positions filled during delay' };
    }

    // Liquidity still valid
    const currentLiq = await this.raydium.getLiquidityUsd(mint).catch(() => 0);
    if (currentLiq < config.filters.minLiquidityUsd) {
      return { ok: false, reason: `Liquidity dropped to $${currentLiq?.toFixed(0)}` };
    }

    // Volume still growing
    const volCheck = await volumeAnalyzer.checkGrowingVolume(mint);
    if (!volCheck.growing) {
      return { ok: false, reason: `Volume stopped growing: ${volCheck.reason}` };
    }

    return { ok: true, liquidityUsd: currentLiq };
  }

  /**
   * Higher score = shorter delay (but always within configured bounds).
   * Score 72 → max delay (~30s)
   * Score 90+ → min delay (~10s)
   */
  _calcDelay(score) {
    const { sniperDelayMin: minMs, sniperDelayMax: maxMs } = config.trading;
    const range   = maxMs - minMs;
    // Normalize score from [minScoreToBuy, 100] → [1, 0]
    const minScore = config.trading.minScoreToBuy;
    const t        = Math.min(1, Math.max(0, (score - minScore) / (100 - minScore)));
    // High score → low factor → short delay
    const jitter   = Math.random() * 2000 - 1000; // ±1s randomness
    return Math.max(minMs, Math.min(maxMs, minMs + range * (1 - t) + jitter));
  }
}

// Export both the class and the decision constants
DecisionEngine.DECISION = DECISION;
module.exports = DecisionEngine;
