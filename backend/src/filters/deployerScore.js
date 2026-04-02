'use strict';

/**
 * Deployer Score Module
 *
 * Scores a deployer wallet based on its historical token launches.
 * Returns a score 0–100 (higher = more trustworthy).
 *
 * Scoring model:
 *   Start:  50
 *   +20   – known good deployer (1–3 launches, older account)
 *   -10   – serial launcher (>10 tokens ever)
 *   -15   – first launch (unknown history)
 *   -20   – high-frequency launcher (>5 tokens in 30 days)
 *   -25   – new wallet (<7 days old)
 *   -30   – rapid launches (>3 in 7 days)
 *   -40   – previously blacklisted mint from same deployer (flag added)
 *
 * Results are cached for 1 hour.
 * If Helius is unavailable: returns { score: 50, flags: ['no_data'] }
 */

const axios  = require('axios');
const config = require('../config/config');
const logger = require('../utils/logger');
const { isBlacklisted } = require('../database/db');

// Cache TTL: 1 hour
const CACHE_TTL_MS = 60 * 60_000;

/** @type {Map<string, { ts: number, result: object }>} */
const _cache = new Map();

/**
 * @typedef {object} DeployerScoreResult
 * @property {number}   score            – 0–100
 * @property {number}   launches         – total launches detected
 * @property {number}   rugRate          – estimated rug rate (0–1, placeholder)
 * @property {number}   avgSurvivalDays  – average days tokens survived (placeholder)
 * @property {string[]} flags            – human-readable risk flags
 */

const deployerScore = {

  /**
   * Score a deployer wallet.
   *
   * @param {string} deployerAddress  – base58 Solana address
   * @returns {Promise<DeployerScoreResult>}
   */
  async score(deployerAddress) {
    if (!deployerAddress) {
      return _noData();
    }

    // Cache hit
    const cached = _cache.get(deployerAddress);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return cached.result;
    }

    if (!config.solana.heliusApiKey) {
      logger.debug('[DeployerScore] No HELIUS_API_KEY — returning neutral score');
      return _noData();
    }

    let transactions;
    try {
      const url = `https://api.helius.xyz/v0/addresses/${deployerAddress}/transactions` +
        `?api-key=${config.solana.heliusApiKey}&type=TRANSFER&limit=100`;

      const { data } = await axios.get(url, { timeout: 10_000 });
      transactions = Array.isArray(data) ? data : [];
    } catch (err) {
      const status = err.response?.status;
      logger.warn('[DeployerScore] Helius fetch error', { status, err: err.message });
      return _noData();
    }

    const result = _computeScore(deployerAddress, transactions);

    // Cache result
    _cache.set(deployerAddress, { ts: Date.now(), result });

    logger.debug('[DeployerScore] Scored deployer', {
      deployer: deployerAddress.slice(0, 8) + '...',
      score: result.score,
      launches: result.launches,
      flags: result.flags,
    });

    return result;
  },

  /**
   * Clear the score cache (optionally for a specific address).
   * @param {string} [address]
   */
  clearCache(address) {
    if (address) _cache.delete(address);
    else _cache.clear();
  },
};

// ── Private helpers ─────────────────────────────────────────────────────────

/**
 * Compute score from transaction history.
 * @param {string}   deployerAddress
 * @param {object[]} transactions
 * @returns {DeployerScoreResult}
 */
function _computeScore(deployerAddress, transactions) {
  const flags = [];
  let score   = 50;

  const now         = Date.now() / 1000; // unix seconds
  const sevenDays   = 7  * 24 * 3600;
  const thirtyDays  = 30 * 24 * 3600;

  // ── Detect InitializeMint instructions (token launches) ─────────────────
  const mintTxs = transactions.filter(tx => _hasMintInit(tx));

  // Collect mints from those transactions
  const allMints = [];
  for (const tx of mintTxs) {
    const mints = _extractMintsFromTx(tx);
    allMints.push(...mints);
  }

  const totalLaunches = mintTxs.length;

  // Timestamps of launch transactions (unix seconds)
  const launchTimestamps = mintTxs
    .map(tx => tx.timestamp || 0)
    .filter(Boolean)
    .sort((a, b) => b - a); // newest first

  const launchesIn30Days = launchTimestamps.filter(ts => now - ts < thirtyDays).length;
  const launchesIn7Days  = launchTimestamps.filter(ts => now - ts < sevenDays).length;

  // Oldest transaction determines wallet age
  const allTimestamps = transactions
    .map(tx => tx.timestamp || 0)
    .filter(Boolean);

  const oldestTxTs = allTimestamps.length ? Math.min(...allTimestamps) : now;
  const walletAgeSeconds = now - oldestTxTs;

  // ── Check for blacklisted mints from this deployer ───────────────────────
  let hasBlacklistedMint = false;
  for (const mint of allMints) {
    if (isBlacklisted(mint)) {
      hasBlacklistedMint = true;
      flags.push(`Previously blacklisted mint: ${mint.slice(0, 8)}...`);
    }
  }

  // ── Apply scoring rules ──────────────────────────────────────────────────

  // Good deployer: 1–3 total launches, wallet older than 90 days
  if (totalLaunches >= 1 && totalLaunches <= 3 && walletAgeSeconds > 90 * 24 * 3600) {
    score += 20;
  }

  // New wallet (<7 days old)
  if (walletAgeSeconds < sevenDays) {
    score -= 25;
    flags.push('Wallet less than 7 days old');
  }

  // First-ever launch (unknown history)
  if (totalLaunches === 0) {
    score -= 15;
    flags.push('No detected token launches (new or unknown deployer)');
  }

  // Serial launcher (>10 tokens ever)
  if (totalLaunches > 10) {
    score -= 10;
    flags.push(`Serial launcher: ${totalLaunches} total launches`);
  }

  // High-frequency launcher (>5 in 30 days)
  if (launchesIn30Days > 5) {
    score -= 20;
    flags.push(`High-frequency launcher: ${launchesIn30Days} tokens in last 30 days`);
  }

  // Rapid launcher (>3 in 7 days)
  if (launchesIn7Days > 3) {
    score -= 30;
    flags.push(`Rapid launches: ${launchesIn7Days} tokens in last 7 days`);
  }

  // Blacklisted mint heavy penalty
  if (hasBlacklistedMint) {
    score -= 40;
  }

  // Clamp to 0–100
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    launches:        totalLaunches,
    rugRate:         0,   // not calculable from tx history alone
    avgSurvivalDays: 0,   // not calculable from tx history alone
    flags,
  };
}

/**
 * Check if a Helius transaction contains an InitializeMint instruction.
 * @param {object} tx
 * @returns {boolean}
 */
function _hasMintInit(tx) {
  // Helius parsed transactions include an `instructions` array at top level
  // and `innerInstructions`. We scan both for InitializeMint.
  const instructions = tx.instructions || [];
  for (const ix of instructions) {
    if (_isInitializeMint(ix)) return true;
    for (const inner of ix.innerInstructions || []) {
      if (_isInitializeMint(inner)) return true;
    }
  }
  // Also check legacy `innerInstructions` field at tx level
  for (const group of tx.innerInstructions || []) {
    for (const inner of group.instructions || []) {
      if (_isInitializeMint(inner)) return true;
    }
  }
  return false;
}

/**
 * Check if a single instruction is InitializeMint.
 * @param {object} ix
 * @returns {boolean}
 */
function _isInitializeMint(ix) {
  // Helius returns `type` field on parsed instructions
  if (ix.type === 'initializeMint' || ix.type === 'initializeMint2') return true;
  // Fallback: check parsed data
  if (ix.parsed?.type === 'initializeMint' || ix.parsed?.type === 'initializeMint2') return true;
  return false;
}

/**
 * Extract mint addresses created in a transaction.
 * @param {object} tx
 * @returns {string[]}
 */
function _extractMintsFromTx(tx) {
  const mints = [];

  const all = [
    ...(tx.instructions || []),
  ];

  for (const ix of all) {
    const mint = ix.parsed?.info?.mint;
    if (mint) mints.push(mint);

    for (const inner of ix.innerInstructions || []) {
      const innerMint = inner.parsed?.info?.mint;
      if (innerMint) mints.push(innerMint);
    }
  }

  // Also from tokenTransfers
  for (const t of tx.tokenTransfers || []) {
    if (t.mint) mints.push(t.mint);
  }

  return [...new Set(mints)];
}

/**
 * Return a neutral "no data" result.
 * @returns {DeployerScoreResult}
 */
function _noData() {
  return { score: 50, launches: 0, rugRate: 0, avgSurvivalDays: 0, flags: ['no_data'] };
}

module.exports = deployerScore;
