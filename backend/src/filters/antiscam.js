'use strict';

/**
 * Anti-Scam Filter Engine — Deep validation before any buy
 *
 * Checks (in order of cost/importance):
 *   1.  Blacklist                  – instant reject (O(1))
 *   2.  Mint authority             – unlimited supply?
 *   3.  Freeze authority           – tokens can be frozen?
 *   4.  Honeypot simulation        – Jupiter round-trip sim
 *   5.  Sell tax detection         – effective tax >15%?
 *   6.  Holder concentration       – top-10 holders
 *   7.  Dev wallet size            – deployer hoarding?
 *   8.  Single whale               – one wallet >20%?
 *   9.  Locked liquidity           – LP locked?
 *   10. Rug pull indicators        – age + supply combo
 *   11. Wash trading signal        – vol/liq extreme ratio
 *   12. Deployer history           – serial rug-puller?
 *   13. Contract age               – too new to trust?
 *
 * Risk scoring: 0 (clean) → 100 (certain scam)
 * Pass threshold: riskScore < 40 AND no honeypot
 */

const { PublicKey }   = require('@solana/web3.js');
const config          = require('../config/config');
const { isBlacklisted, addBlacklist } = require('../database/db');
const { getConnection, getJupiter }   = require('../dex/index');
const logger          = require('../utils/logger');

const CACHE_TTL_MS = 5 * 60_000;
const _cache       = new Map();   // mint → { ts, result }

// Known lock programs on Solana
const LOCK_PROGRAMS = new Set([
  'LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE',  // Streamflow
  'TLockFiRBxSNkuKqVbfCrPnpGcHjPqFh27TfhJj1GkH',  // Raydium lock
  '7sPptkymzvayoSbLXzBsXEF8TSf3typNnAWkrKrDhjNm',  // Unicrypt
]);

class AntiScamFilter {
  constructor() {
    this.connection = getConnection();
    this.jupiter    = getJupiter();
  }

  /**
   * Run all checks on a token.
   * @param {object} tokenInfo  – { mint, deployer, symbol, lockedLiqPct, ... }
   * @returns {Promise<{pass: boolean, reasons: string[], riskScore: number}>}
   */
  async check(tokenInfo) {
    const { mint, deployer } = tokenInfo;

    const cached = _cache.get(mint);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.result;

    const reasons = [];
    let risk      = 0;

    // ── 1. Blacklist (O(1)) ───────────────────────────────────────────────
    if (isBlacklisted(mint)) return this._cache(mint, this._fail(['Contract blacklisted'], 100));
    if (deployer && isBlacklisted(deployer)) return this._cache(mint, this._fail(['Deployer blacklisted'], 100));
    if (config.filters.blacklistContracts?.includes(mint))
      return this._cache(mint, this._fail(['Contract in config blacklist'], 100));
    if (deployer && config.filters.blacklistDeployers?.includes(deployer))
      return this._cache(mint, this._fail(['Deployer in config blacklist'], 100));

    // ── 2 & 3. On-chain mint info ─────────────────────────────────────────
    const mintInfo = await this._getMintInfo(mint);
    if (!mintInfo) return this._cache(mint, this._fail(['Cannot read mint account'], 80));

    if (config.filters.requireMintRenounced && mintInfo.mintAuthoritySet) {
      reasons.push('Mint authority active — unlimited supply possible');
      risk += 35;
    }
    if (config.filters.requireFreezeRenounced && mintInfo.freezeAuthoritySet) {
      reasons.push('Freeze authority active — tokens can be frozen');
      risk += 30;
    }

    // ── 4 & 5. Honeypot + tax simulation (Jupiter round-trip) ─────────────
    const sim = await this.jupiter.simulateRoundTrip(mint, 500_000);

    if (!sim.canSell) {
      addBlacklist(mint, 'contract', 'honeypot-no-sell');
      return this._cache(mint, this._fail(['Cannot simulate sell — honeypot'], 100));
    }
    if (sim.taxPct > 90) {
      addBlacklist(mint, 'contract', `honeypot-tax-${sim.taxPct.toFixed(0)}pct`);
      return this._cache(mint, this._fail([`Effective sell tax ${sim.taxPct.toFixed(1)}% — honeypot`], 100));
    }
    if (sim.taxPct > 20) {
      reasons.push(`High sell tax ${sim.taxPct.toFixed(1)}%`);
      risk += 25;
    } else if (sim.taxPct > 10) {
      reasons.push(`Moderate sell tax ${sim.taxPct.toFixed(1)}%`);
      risk += 10;
    }

    // ── 6, 7, 8. Holder distribution ─────────────────────────────────────
    const holders = await this._getHolderMetrics(mint, mintInfo.supply, deployer);

    if (holders.top10Pct > config.filters.maxTop10HoldersPct) {
      reasons.push(`Top-10 hold ${(holders.top10Pct * 100).toFixed(1)}% — whale risk`);
      risk += 25;
    }
    if (holders.singleTopPct > 0.20) {
      reasons.push(`Largest holder owns ${(holders.singleTopPct * 100).toFixed(1)}%`);
      risk += 15;
    }
    if (holders.devPct > config.filters.maxDevWalletPct) {
      reasons.push(`Dev wallet holds ${(holders.devPct * 100).toFixed(1)}%`);
      risk += 30;
    }

    // ── 9. Locked liquidity check ─────────────────────────────────────────
    const lockedPct = tokenInfo.lockedLiqPct ?? 0;
    if (lockedPct < config.filters.minLockedLiquidityPct) {
      reasons.push(`Only ${(lockedPct * 100).toFixed(0)}% LP locked (min ${(config.filters.minLockedLiquidityPct * 100).toFixed(0)}%)`);
      risk += lockedPct < 0.3 ? 25 : 10;
    }

    // ── 10. Rug-pull combo indicators ─────────────────────────────────────
    const ageSeconds = tokenInfo.launch_ts
      ? Math.floor(Date.now() / 1000) - tokenInfo.launch_ts
      : 999;

    if (ageSeconds < 60 && Number(mintInfo.supply) > 1e15) {
      reasons.push('Very new token (<60s) with huge supply');
      risk += 10;
    }

    // ── 11. Wash trading signal ───────────────────────────────────────────
    if (tokenInfo.liquidityUsd && tokenInfo.volume24h) {
      const ratio = tokenInfo.volume24h / tokenInfo.liquidityUsd;
      if (ratio > 50) {
        reasons.push(`Suspicious vol/liq ratio ${ratio.toFixed(0)}x`);
        risk += 15;
      }
    }

    // ── 12. Deployer history ──────────────────────────────────────────────
    if (deployer) {
      const devFlags = await this._checkDeployerReputation(deployer);
      risk  += devFlags.risk;
      reasons.push(...devFlags.reasons);
    }

    // ── 13. Token contract age ────────────────────────────────────────────
    if (ageSeconds < 15) {
      reasons.push('Token is less than 15 seconds old');
      risk += 5;
    }

    const pass   = risk < 40;
    const result = { pass, reasons, riskScore: risk };

    if (!pass) logger.warn('[AntiScam] Failed', { mint, risk, reasons });
    else       logger.debug('[AntiScam] Passed', { mint, risk });

    return this._cache(mint, result);
  }

  clearCache(mint) {
    if (mint) _cache.delete(mint);
    else _cache.clear();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  async _getMintInfo(mint) {
    try {
      const info   = await this.connection.getParsedAccountInfo(new PublicKey(mint));
      const parsed = info?.value?.data?.parsed?.info;
      if (!parsed) return null;
      return {
        supply:            BigInt(parsed.supply),
        decimals:          parsed.decimals,
        mintAuthoritySet:  !!parsed.mintAuthority,
        freezeAuthoritySet: !!parsed.freezeAuthority,
      };
    } catch { return null; }
  }

  async _getHolderMetrics(mint, totalSupply, deployer) {
    try {
      const { value } = await this.connection.getTokenLargestAccounts(new PublicKey(mint));
      const top10     = value.slice(0, 10);
      const total     = Number(totalSupply);
      const amounts   = top10.map(a => Number(a.amount));

      const top10Amount   = amounts.reduce((s, v) => s + v, 0);
      const top10Pct      = total > 0 ? top10Amount / total : 0;
      const singleTopPct  = total > 0 ? amounts[0] / total  : 0;

      // Try to find deployer wallet in top holders
      let devPct = 0;
      if (deployer) {
        for (const holder of top10) {
          try {
            const info = await this.connection.getParsedAccountInfo(holder.address);
            const owner = info?.value?.data?.parsed?.info?.owner;
            if (owner === deployer) {
              devPct = Number(holder.amount) / total;
              break;
            }
          } catch { /* skip */ }
        }
      }

      return { top10Pct, singleTopPct, devPct };
    } catch {
      return { top10Pct: 0, singleTopPct: 0, devPct: 0 };
    }
  }

  async _checkDeployerReputation(deployer) {
    const reasons = [];
    let risk      = 0;

    try {
      const sigs = await this.connection.getSignaturesForAddress(
        new PublicKey(deployer), { limit: 100 }
      );

      // Serial deployer: many tokens launched rapidly = rug factory
      const recentInHour = sigs.filter(s =>
        s.blockTime && Date.now() / 1000 - s.blockTime < 3600
      ).length;

      if (recentInHour > 20) {
        reasons.push(`Deployer has ${recentInHour} transactions in last hour — serial deployer`);
        risk += 20;
      }

      // Very fresh deployer wallet (< 50 lifetime txs) = throw-away wallet
      if (sigs.length < 10) {
        reasons.push('Deployer is a very fresh wallet (< 10 txns)');
        risk += 10;
      }
    } catch { /* RPC errors are non-fatal */ }

    return { reasons, risk };
  }

  _fail(reasons, riskScore) {
    return { pass: false, reasons, riskScore };
  }

  _cache(mint, result) {
    _cache.set(mint, { ts: Date.now(), result });
    return result;
  }
}

module.exports = AntiScamFilter;
