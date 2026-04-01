'use strict';

/**
 * Raydium integration – pool data, liquidity monitoring, new pool detection.
 */

const axios = require('axios');
const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const config = require('../config/config');
const logger = require('../utils/logger');

const RAYDIUM_API = config.dex.raydiumApiUrl;

// Well-known Raydium AMM Program IDs
const AMM_V4_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const LIQUIDITY_STATE_SIZE = 752; // bytes for AMM v4 pool account

class RaydiumDex {
  constructor(connection) {
    this.connection = connection;
    this._poolCache = new Map();
  }

  /**
   * Fetch pool info from Raydium REST API.
   * Returns liquidity, price, volume24h.
   */
  async getPoolInfo(tokenMint) {
    try {
      const { data } = await axios.get(`${RAYDIUM_API}/ammV3/ammPools`, {
        params: { mint1: tokenMint },
        timeout: 5000,
      });
      const pools = data?.data || [];
      if (!pools.length) return null;
      // Return the pool with most liquidity
      return pools.sort((a, b) => b.tvl - a.tvl)[0];
    } catch (err) {
      logger.debug('[Raydium] getPoolInfo error', { tokenMint, err: err.message });
      return null;
    }
  }

  /**
   * Get liquidity in USD for a token.
   */
  async getLiquidityUsd(tokenMint) {
    const pool = await this.getPoolInfo(tokenMint);
    return pool ? (pool.tvl || 0) : 0;
  }

  /**
   * Subscribe to new Raydium AMM pool creation events via WebSocket.
   * Calls onNewPool(poolMeta) for each discovered pool.
   *
   * @param {Function} onNewPool
   */
  subscribeNewPools(onNewPool) {
    const { Connection } = require('@solana/web3.js');
    const conn = this.connection;

    logger.info('[Raydium] Subscribing to new AMM pool events...');

    const subId = conn.onProgramAccountChange(
      new PublicKey(AMM_V4_PROGRAM),
      async (accountInfo, context) => {
        // Only process accounts of the right size (new pool creation)
        if (accountInfo.accountInfo.data.length !== LIQUIDITY_STATE_SIZE) return;
        try {
          const parsed = this._parsePoolState(accountInfo.accountInfo.data, accountInfo.accountId);
          if (!parsed) return;
          if (this._poolCache.has(parsed.poolId)) return;
          this._poolCache.set(parsed.poolId, true);

          logger.info('[Raydium] New pool detected', {
            poolId: parsed.poolId,
            baseMint: parsed.baseMint,
            quoteMint: parsed.quoteMint,
          });

          await onNewPool(parsed);
        } catch (err) {
          logger.debug('[Raydium] parse pool error', { err: err.message });
        }
      },
      'confirmed',
      [{ dataSize: LIQUIDITY_STATE_SIZE }]
    );

    return () => conn.removeProgramAccountChangeListener(subId);
  }

  /**
   * Check if liquidity is locked (via API or on-chain lock contract check).
   * Returns fraction of locked liquidity (0–1).
   */
  async getLiquidityLockFraction(poolId) {
    // Check Raydium lock program or third-party lock services (Streamflow, Unicrypt)
    // This is a simplified heuristic check via Raydium API
    try {
      const { data } = await axios.get(`${RAYDIUM_API}/ammV3/positionLine`, {
        params: { pool_id: poolId },
        timeout: 5000,
      });
      const positions = data?.data || [];
      // Positions held by known lock contracts are treated as locked
      const LOCK_PROGRAMS = [
        'LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE',  // Streamflow
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',  // SPL Token (burn address check)
      ];
      const total = positions.reduce((s, p) => s + (p.liquidity || 0), 0);
      const locked = positions
        .filter(p => LOCK_PROGRAMS.includes(p.owner))
        .reduce((s, p) => s + (p.liquidity || 0), 0);
      return total > 0 ? locked / total : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Get 24h volume for a pool.
   */
  async getVolume24h(tokenMint) {
    const pool = await this.getPoolInfo(tokenMint);
    return pool ? (pool.volume24h || 0) : 0;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  _parsePoolState(data, accountId) {
    // Minimal layout parse for Raydium AMM v4 pool state
    // Offsets based on raydium-sdk layout
    try {
      const BASE_MINT_OFFSET = 400;
      const QUOTE_MINT_OFFSET = 432;
      const baseMint = new PublicKey(data.slice(BASE_MINT_OFFSET, BASE_MINT_OFFSET + 32)).toBase58();
      const quoteMint = new PublicKey(data.slice(QUOTE_MINT_OFFSET, QUOTE_MINT_OFFSET + 32)).toBase58();

      return {
        poolId: accountId.toBase58(),
        baseMint,
        quoteMint,
        // Determine which is the "new" memecoin vs SOL/USDC
        tokenMint: baseMint === config.dex.wsolMint || baseMint === config.dex.usdcMint
          ? quoteMint
          : baseMint,
      };
    } catch {
      return null;
    }
  }
}

module.exports = RaydiumDex;
