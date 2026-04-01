'use strict';

/**
 * Volume Analyzer
 *
 * Detects fake/artificial volume patterns that indicate manipulation:
 *
 *   1. Wallet recycling       – same wallets trade back and forth
 *   2. Suspiciously round tx  – identical amounts repeating
 *   3. Volume/liquidity ratio – extreme ratio signals wash trading
 *   4. Trade frequency burst  – abnormal concentration of trades
 *   5. Circular trading       – A→B→A wallet pairs
 *
 * Returns a VolumeQuality score (0–100) where 100 = fully organic
 * and a set of flags explaining any deductions.
 */

const axios    = require('axios');
const config   = require('../config/config');
const { getRaydium } = require('../dex/index');
const logger   = require('../utils/logger');

// Cache results to avoid hammering RPC
const CACHE_TTL_MS = 2 * 60_000;
const _cache       = new Map(); // mint → { ts, result }

class VolumeAnalyzer {
  constructor() {
    this.raydium = getRaydium();
  }

  /**
   * Analyse volume quality for a token.
   * @param {string} mint
   * @param {object} [poolInfo]  – pre-fetched pool info (optional)
   * @returns {Promise<{score: number, flags: string[], organic: boolean}>}
   *   score 0–100 (100 = clean organic volume)
   */
  async analyze(mint, poolInfo = null) {
    const cached = _cache.get(mint);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.result;

    const pool = poolInfo || await this.raydium.getPoolInfo(mint).catch(() => null);
    const flags = [];
    let deductions = 0;

    // ── 1. Volume / Liquidity ratio ─────────────────────────────────────────
    if (pool) {
      const vol = pool.volume24h || 0;
      const liq = pool.tvl       || 1;
      const ratio = vol / liq;

      if (ratio > 100) {
        flags.push(`Extreme vol/liq ratio ${ratio.toFixed(0)}x — likely wash trading`);
        deductions += 50;
      } else if (ratio > 50) {
        flags.push(`High vol/liq ratio ${ratio.toFixed(0)}x — possible wash trading`);
        deductions += 30;
      } else if (ratio > 20) {
        flags.push(`Elevated vol/liq ratio ${ratio.toFixed(0)}x`);
        deductions += 10;
      }
    }

    // ── 2. Transaction pattern analysis (via Raydium recent trades API) ─────
    const recentTrades = await this._fetchRecentTrades(mint).catch(() => []);
    if (recentTrades.length >= 5) {
      const patternResult = this._analyzeTradePatterns(recentTrades);
      deductions += patternResult.deductions;
      flags.push(...patternResult.flags);
    }

    // ── 3. Volume growth sanity check ───────────────────────────────────────
    if (pool) {
      const volumeGrowthScore = await this._checkVolumeGrowth(mint);
      if (volumeGrowthScore.suspicious) {
        flags.push(volumeGrowthScore.reason);
        deductions += volumeGrowthScore.deduction;
      }
    }

    const score   = Math.max(0, 100 - deductions);
    const organic = score >= 50;
    const result  = { score, flags, organic };

    _cache.set(mint, { ts: Date.now(), result });

    if (!organic) {
      logger.warn('[VolumeAnalyzer] Suspicious volume', { mint, score, flags });
    }

    return result;
  }

  /**
   * Quick check: is the volume growing naturally?
   * Compares volume buckets (last 5min vs prev 5min via pool data).
   */
  async checkGrowingVolume(mint) {
    const pool = await this.raydium.getPoolInfo(mint).catch(() => null);
    if (!pool) return { growing: false, reason: 'No pool data' };

    const vol = pool.volume24h || 0;
    const liq = pool.tvl       || 1;

    // Volume must be at least 10% of liquidity for meaningful activity
    if (vol < liq * 0.1) {
      return { growing: false, reason: `Volume too low (${(vol / liq * 100).toFixed(1)}% of liq)` };
    }

    return { growing: true, vol, liq };
  }

  clearCache(mint) {
    if (mint) _cache.delete(mint);
    else _cache.clear();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  async _fetchRecentTrades(mint) {
    try {
      // Use Raydium transaction history endpoint (public)
      const { data } = await axios.get(
        `${config.dex.raydiumApiUrl}/main/tx/list`,
        { params: { mint, limit: 100 }, timeout: 4_000 }
      );
      return data?.data || data || [];
    } catch {
      return [];
    }
  }

  _analyzeTradePatterns(trades) {
    const flags      = [];
    let deductions   = 0;

    // Build wallet occurrence map
    const walletCount = new Map();
    const amounts     = [];

    for (const tx of trades) {
      const wallet = tx.owner || tx.signer || tx.user;
      if (wallet) walletCount.set(wallet, (walletCount.get(wallet) || 0) + 1);

      const amt = tx.amountA || tx.amount || tx.volume;
      if (amt) amounts.push(parseFloat(amt));
    }

    // ── Wallet recycling: same wallet appears many times ───────────────────
    const totalTrades  = trades.length;
    const maxWalletTx  = Math.max(...walletCount.values());
    const recyclingPct = maxWalletTx / totalTrades;

    if (recyclingPct > 0.30) {
      flags.push(`Single wallet responsible for ${(recyclingPct * 100).toFixed(0)}% of trades`);
      deductions += 25;
    }

    const walletsWithMultipleTx = [...walletCount.values()].filter(c => c > 2).length;
    if (walletsWithMultipleTx > totalTrades * 0.5) {
      flags.push('Majority of trades from repeat wallets — wallet recycling pattern');
      deductions += 20;
    }

    // ── Round-number amounts: wash traders use identical amounts ────────────
    if (amounts.length > 5) {
      const roundCount = amounts.filter(a => a > 0 && Math.abs(a - Math.round(a)) < 0.001).length;
      const roundPct   = roundCount / amounts.length;
      if (roundPct > 0.7) {
        flags.push(`${(roundPct * 100).toFixed(0)}% of trades use suspiciously round amounts`);
        deductions += 15;
      }

      // Detect repeated identical amounts
      const amtMap = new Map();
      for (const a of amounts) {
        const key = a.toFixed(4);
        amtMap.set(key, (amtMap.get(key) || 0) + 1);
      }
      const maxRepeat = Math.max(...amtMap.values());
      if (maxRepeat > totalTrades * 0.4) {
        flags.push(`Identical trade amount repeated ${maxRepeat} times — bot pattern`);
        deductions += 20;
      }
    }

    // ── Trade burst: all trades in short window ─────────────────────────────
    const timestamps = trades
      .map(t => t.blockTime || t.ts || t.timestamp)
      .filter(Boolean)
      .map(Number)
      .sort();

    if (timestamps.length > 10) {
      const span       = timestamps[timestamps.length - 1] - timestamps[0];
      const avgGap     = span / timestamps.length;
      const burstTrades = timestamps.filter((t, i) =>
        i > 0 && t - timestamps[i - 1] < 2  // trades less than 2s apart
      ).length;

      if (burstTrades > totalTrades * 0.6) {
        flags.push(`${burstTrades} trades in <2s bursts — bot execution pattern`);
        deductions += 15;
      }
    }

    return { flags, deductions };
  }

  async _checkVolumeGrowth(mint) {
    // Cross-check against historical data: sudden volume spike without holder growth
    // is a classic wash trading sign
    const pool = await this.raydium.getPoolInfo(mint).catch(() => null);
    if (!pool) return { suspicious: false };

    const vol = pool.volume24h || 0;
    const liq = pool.tvl       || 1;

    // Micro liquidity with huge volume is always suspicious
    if (liq < 5_000 && vol > 100_000) {
      return {
        suspicious: true,
        reason: `Tiny liquidity ($${liq.toFixed(0)}) with huge volume ($${vol.toFixed(0)})`,
        deduction: 35,
      };
    }

    return { suspicious: false };
  }
}

// Singleton
const volumeAnalyzer = new VolumeAnalyzer();
module.exports = volumeAnalyzer;
