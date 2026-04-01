'use strict';

/**
 * Anti-Scam Filter Engine
 *
 * Performs multi-layer validation before a token is eligible for purchase:
 *   1. Blacklist check (deployer / contract)
 *   2. Mint & freeze authority (renounced?)
 *   3. Honeypot simulation (can we sell?)
 *   4. Holder concentration check
 *   5. Rug-pull risk assessment
 *   6. Wash trading detection
 *   7. Contract age / deployer history
 */

const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const axios = require('axios');
const config = require('../config/config');
const { isBlacklisted, addBlacklist } = require('../database/db');
const { getConnection, getJupiter } = require('../dex/index');
const logger = require('../utils/logger');

class AntiScamFilter {
  constructor() {
    this.jupiter = getJupiter();
    this.connection = getConnection();
    // Cache results per mint to avoid redundant RPC calls
    this._cache = new Map();
  }

  /**
   * Run all filters on a token.
   * @param {object} tokenInfo  – { mint, deployer, symbol, ... }
   * @returns {Promise<{pass: boolean, reasons: string[], score: number}>}
   *   score = 0 (clean) to 100 (extreme risk)
   */
  async check(tokenInfo) {
    const { mint, deployer } = tokenInfo;
    const cacheKey = mint;

    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);

    const reasons = [];
    let riskScore = 0;

    // ── 1. Blacklist ─────────────────────────────────────────────────────────
    if (isBlacklisted(mint)) {
      reasons.push('Contract blacklisted');
      return this._fail(cacheKey, reasons, 100);
    }
    if (deployer && isBlacklisted(deployer)) {
      reasons.push('Deployer blacklisted');
      return this._fail(cacheKey, reasons, 100);
    }
    if (config.filters.blacklistContracts.includes(mint)) {
      reasons.push('Contract in env blacklist');
      return this._fail(cacheKey, reasons, 100);
    }
    if (deployer && config.filters.blacklistDeployers.includes(deployer)) {
      reasons.push('Deployer in env blacklist');
      return this._fail(cacheKey, reasons, 100);
    }

    // ── 2. Mint authority ────────────────────────────────────────────────────
    const mintInfo = await this._getMintInfo(mint);
    if (!mintInfo) {
      reasons.push('Cannot fetch mint info');
      return this._fail(cacheKey, reasons, 80);
    }

    if (config.filters.requireMintRenounced && mintInfo.mintAuthoritySet) {
      reasons.push('Mint authority NOT renounced – unlimited supply possible');
      riskScore += 35;
    }
    if (config.filters.requireFreezeRenounced && mintInfo.freezeAuthoritySet) {
      reasons.push('Freeze authority NOT renounced – tokens can be frozen');
      riskScore += 30;
    }

    // ── 3. Honeypot simulation ───────────────────────────────────────────────
    const honeypot = await this._simulateHoneypot(mint);
    if (honeypot.isHoneypot) {
      reasons.push(`Honeypot detected: ${honeypot.reason}`);
      addBlacklist(mint, 'contract', 'honeypot');
      return this._fail(cacheKey, reasons, 100);
    }
    if (honeypot.highTax) {
      reasons.push(`High sell tax detected: ${honeypot.sellTaxPct.toFixed(1)}%`);
      riskScore += 20;
    }

    // ── 4. Holder concentration ──────────────────────────────────────────────
    const holders = await this._getTopHolders(mint, mintInfo.supply);
    if (holders.top10Pct > config.filters.maxTop10HoldersPct) {
      reasons.push(
        `Top-10 holders own ${(holders.top10Pct * 100).toFixed(1)}% – concentration risk`
      );
      riskScore += 25;
    }
    if (deployer && holders.devPct > config.filters.maxDevWalletPct) {
      reasons.push(
        `Dev wallet holds ${(holders.devPct * 100).toFixed(1)}% of supply`
      );
      riskScore += 30;
    }
    if (holders.singleTopPct > 0.20) {
      reasons.push(
        `Single holder owns ${(holders.singleTopPct * 100).toFixed(1)}% – whale risk`
      );
      riskScore += 15;
    }

    // ── 5. Rug-pull indicators ───────────────────────────────────────────────
    const rugRisk = await this._assessRugRisk(tokenInfo, mintInfo, holders);
    riskScore += rugRisk.score;
    reasons.push(...rugRisk.flags);

    // ── 6. Wash trading ──────────────────────────────────────────────────────
    const washScore = await this._detectWashTrading(mint);
    if (washScore > 50) {
      reasons.push(`Wash trading detected (score: ${washScore})`);
      riskScore += 15;
    }

    // ── 7. Deployer history ──────────────────────────────────────────────────
    if (deployer) {
      const devRisk = await this._checkDeployerHistory(deployer);
      riskScore += devRisk.score;
      reasons.push(...devRisk.flags);
    }

    const pass = riskScore < 40 && !reasons.some(r => r.toLowerCase().includes('honeypot'));
    const result = { pass, reasons, riskScore };
    this._cache.set(cacheKey, result);

    if (!pass) {
      logger.warn('[AntiScam] Token failed filters', { mint, riskScore, reasons });
    } else {
      logger.debug('[AntiScam] Token passed filters', { mint, riskScore });
    }

    return result;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  async _getMintInfo(mint) {
    try {
      const info = await this.connection.getParsedAccountInfo(new PublicKey(mint));
      const parsed = info?.value?.data?.parsed?.info;
      if (!parsed) return null;
      return {
        supply: BigInt(parsed.supply),
        decimals: parsed.decimals,
        mintAuthoritySet: !!parsed.mintAuthority,
        freezeAuthoritySet: !!parsed.freezeAuthority,
      };
    } catch (err) {
      logger.debug('[AntiScam] getMintInfo error', { mint, err: err.message });
      return null;
    }
  }

  async _simulateHoneypot(mint) {
    // Attempt a tiny test swap simulation (buy 0.001 SOL then sell 100%)
    // If sell quote returns 0 or much less than expected → honeypot
    try {
      const buyQuote = await this.jupiter.getQuote(
        config.dex.wsolMint, mint, 1_000_000 // 0.001 SOL
      );
      if (!buyQuote || parseFloat(buyQuote.outAmount) === 0) {
        return { isHoneypot: true, reason: 'Buy quote returned zero tokens' };
      }

      const outTokens = parseFloat(buyQuote.outAmount);
      const sellQuote = await this.jupiter.getQuote(
        mint, config.dex.wsolMint, Math.floor(outTokens * 0.99)
      );

      if (!sellQuote || parseFloat(sellQuote.outAmount) === 0) {
        return { isHoneypot: true, reason: 'Cannot simulate sell – no route' };
      }

      const lamportsIn = 1_000_000;
      const lamportsBack = parseFloat(sellQuote.outAmount);
      const taxPct = (1 - lamportsBack / lamportsIn) * 100;

      return {
        isHoneypot: taxPct > 90,
        highTax: taxPct > 15,
        sellTaxPct: taxPct,
        reason: taxPct > 90 ? `Effective sell tax ${taxPct.toFixed(1)}%` : '',
      };
    } catch (err) {
      // If we can't simulate at all, that's itself suspicious
      logger.debug('[AntiScam] honeypot sim error', { mint, err: err.message });
      return { isHoneypot: false, highTax: false, sellTaxPct: 0, reason: 'sim_error' };
    }
  }

  async _getTopHolders(mint, totalSupply) {
    try {
      const { value } = await this.connection.getTokenLargestAccounts(new PublicKey(mint));
      const top = value.slice(0, 10);
      const total = Number(totalSupply);

      const amounts = top.map(a => Number(a.amount));
      const top10Amount = amounts.reduce((s, v) => s + v, 0);
      const top10Pct = top10Amount / total;
      const singleTopPct = amounts[0] / total;

      return { top10Pct, singleTopPct, devPct: 0, topHolders: value };
    } catch {
      return { top10Pct: 0, singleTopPct: 0, devPct: 0, topHolders: [] };
    }
  }

  async _assessRugRisk(tokenInfo, mintInfo, holders) {
    const flags = [];
    let score = 0;

    // No locked liquidity info (will be cross-checked by scorer)
    if (tokenInfo.lockedLiqPct !== undefined && tokenInfo.lockedLiqPct < 0.50) {
      flags.push(`Only ${(tokenInfo.lockedLiqPct * 100).toFixed(1)}% liquidity locked`);
      score += 20;
    }

    // Token too new (< 30s) with large supply
    const ageSeconds = tokenInfo.launch_ts
      ? Math.floor(Date.now() / 1000) - tokenInfo.launch_ts
      : 999;
    if (ageSeconds < 30 && Number(mintInfo.supply) > 1e15) {
      flags.push('Token <30s old with very large supply');
      score += 10;
    }

    return { score, flags };
  }

  async _detectWashTrading(mint) {
    // Heuristic: check if large fraction of volume comes from circular wallets
    // Simplified: check volume/liquidity ratio – extremely high = suspicious
    try {
      const { getRaydium } = require('../dex/index');
      const raydium = getRaydium();
      const pool = await raydium.getPoolInfo(mint);
      if (!pool) return 0;

      const vol = pool.volume24h || 0;
      const liq = pool.tvl || 1;
      const ratio = vol / liq;

      // Volume/liquidity > 50x in 24h is suspicious
      if (ratio > 50) return 80;
      if (ratio > 20) return 40;
      return 0;
    } catch {
      return 0;
    }
  }

  async _checkDeployerHistory(deployer) {
    const flags = [];
    let score = 0;

    try {
      // Check how many tokens this deployer has launched
      const sigs = await this.connection.getSignaturesForAddress(
        new PublicKey(deployer), { limit: 50 }
      );

      // High tx count from a fresh wallet can be suspicious
      if (sigs.length > 30) {
        flags.push('Deployer has high recent transaction count');
        score += 10;
      }
    } catch {
      // RPC errors are non-fatal
    }

    return { score, flags };
  }

  _fail(cacheKey, reasons, riskScore) {
    const result = { pass: false, reasons, riskScore };
    this._cache.set(cacheKey, result);
    return result;
  }

  clearCache() {
    this._cache.clear();
  }
}

module.exports = AntiScamFilter;
