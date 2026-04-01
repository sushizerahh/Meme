'use strict';

/**
 * Token Scanner
 *
 * Detects new tokens/pools on Solana via:
 *   1. Raydium WebSocket pool creation events
 *   2. On-chain program account changes (SPL Token program)
 *   3. Periodic polling fallback
 *
 * Emits 'newToken' event with raw token metadata for downstream processing.
 */

const EventEmitter = require('eventemitter3');
const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const config = require('../config/config');
const { getRaydium, getConnection } = require('../dex/index');
const { upsertToken, isBlacklisted } = require('../database/db');
const logger = require('../utils/logger');

const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

class TokenScanner extends EventEmitter {
  constructor() {
    super();
    this.raydium = getRaydium();
    this.connection = getConnection();
    this._seen = new Set();
    this._unsub = null;
    this._pollInterval = null;
  }

  start() {
    logger.info('[Scanner] Starting token scanner...');

    // Primary: Raydium new pool events via WebSocket
    this._unsub = this.raydium.subscribeNewPools(async (pool) => {
      await this._handleNewPool(pool);
    });

    // Fallback: poll Raydium new pools API every 15s
    this._pollInterval = setInterval(() => this._pollNewTokens(), 15_000);

    logger.info('[Scanner] Token scanner running');
  }

  stop() {
    if (this._unsub) { this._unsub(); this._unsub = null; }
    if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
    logger.info('[Scanner] Token scanner stopped');
  }

  // ─── Handlers ────────────────────────────────────────────────────────────

  async _handleNewPool(pool) {
    const { tokenMint, poolId, baseMint, quoteMint } = pool;
    if (!tokenMint) return;
    if (this._seen.has(tokenMint)) return;
    this._seen.add(tokenMint);

    if (isBlacklisted(tokenMint)) {
      logger.debug('[Scanner] Skipping blacklisted token', { tokenMint });
      return;
    }

    logger.info('[Scanner] New pool detected', { tokenMint, poolId });

    try {
      const tokenInfo = await this._enrichToken(tokenMint, deployer => {}, poolId);
      if (!tokenInfo) return;

      // Persist to DB
      upsertToken({
        mint: tokenMint,
        symbol: tokenInfo.symbol || '???',
        name: tokenInfo.name || '',
        decimals: tokenInfo.decimals || 6,
        deployer: tokenInfo.deployer || null,
        launch_ts: Math.floor(Date.now() / 1000),
        score: null,
        score_detail: null,
        status: 'watching',
      });

      this.emit('newToken', {
        ...tokenInfo,
        mint: tokenMint,
        poolId,
        detectedAt: Date.now(),
      });
    } catch (err) {
      logger.debug('[Scanner] Error processing new pool', { tokenMint, err: err.message });
    }
  }

  async _pollNewTokens() {
    // Fallback: query Raydium API for recently created pools
    try {
      const axios = require('axios');
      const { data } = await axios.get(`${config.dex.raydiumApiUrl}/main/pairs`, {
        params: { sort_by: 'created', sort: 'desc', limit: 20 },
        timeout: 5000,
      });
      const pairs = data?.data || data || [];

      for (const pair of pairs) {
        const tokenMint = pair.baseMint || pair.base_mint;
        if (!tokenMint || this._seen.has(tokenMint)) continue;

        // Only process pairs created in the last 3 minutes
        const createdTs = pair.createdAt || pair.created_at;
        if (createdTs && Date.now() / 1000 - createdTs > config.trading.maxTokenAgeSeconds) continue;

        this._seen.add(tokenMint);
        await this._handleNewPool({ tokenMint, poolId: pair.ammId || pair.amm_id });
      }
    } catch (err) {
      logger.debug('[Scanner] Poll error', { err: err.message });
    }
  }

  // ─── Token enrichment ────────────────────────────────────────────────────

  async _enrichToken(mint, onDeployer, poolId) {
    try {
      const conn = this.connection;
      const pubkey = new PublicKey(mint);

      // Fetch mint account
      const mintAcct = await conn.getParsedAccountInfo(pubkey);
      const mintData = mintAcct?.value?.data?.parsed?.info;
      if (!mintData) return null;

      const deployer = await this._findDeployer(mint);

      // Try to get metadata (Metaplex)
      const meta = await this._getMetaplexMetadata(mint);

      return {
        mint,
        symbol: meta?.symbol || '',
        name: meta?.name || '',
        decimals: mintData.decimals,
        supply: mintData.supply,
        mintAuthoritySet: !!mintData.mintAuthority,
        freezeAuthoritySet: !!mintData.freezeAuthority,
        mintRenounced: !mintData.mintAuthority,
        freezeRenounced: !mintData.freezeAuthority,
        deployer,
        poolId,
      };
    } catch (err) {
      logger.debug('[Scanner] enrichToken error', { mint, err: err.message });
      return null;
    }
  }

  async _findDeployer(mint) {
    try {
      // Find the first transaction that created this mint
      const sigs = await this.connection.getSignaturesForAddress(
        new PublicKey(mint), { limit: 1 }
      );
      if (!sigs.length) return null;

      // The signer of the oldest tx is typically the deployer
      const tx = await this.connection.getParsedTransaction(sigs[sigs.length - 1].signature, {
        maxSupportedTransactionVersion: 0,
      });
      return tx?.transaction?.message?.accountKeys?.[0]?.pubkey?.toBase58() || null;
    } catch {
      return null;
    }
  }

  async _getMetaplexMetadata(mint) {
    // Derive Metaplex metadata PDA
    try {
      const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
      const [metadataPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), new PublicKey(mint).toBuffer()],
        METADATA_PROGRAM
      );
      const acctInfo = await this.connection.getAccountInfo(metadataPda);
      if (!acctInfo) return null;

      // Parse minimal metadata: name (offset 65) and symbol (offset 101)
      const data = acctInfo.data;
      const readString = (offset) => {
        const len = data.readUInt32LE(offset);
        return data.slice(offset + 4, offset + 4 + len).toString('utf8').replace(/\0/g, '');
      };
      const name = readString(65).trim();
      const symbol = readString(101).trim();
      return { name, symbol };
    } catch {
      return null;
    }
  }
}

module.exports = TokenScanner;
