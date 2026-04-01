'use strict';

/**
 * Jupiter Aggregator v6 integration
 * Handles quote fetching and swap transaction building.
 */

const axios = require('axios');
const {
  Connection,
  VersionedTransaction,
  PublicKey,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const config = require('../config/config');
const logger = require('../utils/logger');

const JUP_API = config.dex.jupiterApiUrl;
const WSOL = config.dex.wsolMint;

class JupiterDex {
  constructor(connection) {
    this.connection = connection;
  }

  /**
   * Fetch a swap quote from Jupiter.
   * @param {string} inputMint
   * @param {string} outputMint
   * @param {number} amountLamports  – integer, in smallest units
   * @param {number} slippageBps
   * @returns {Promise<object>} quoteResponse
   */
  async getQuote(inputMint, outputMint, amountLamports, slippageBps = config.trading.slippageBps) {
    const url = `${JUP_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
      `&amount=${amountLamports}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;

    const { data } = await axios.get(url, { timeout: 5000 });
    return data;
  }

  /**
   * Build a swap transaction.
   * @param {object} quoteResponse  – from getQuote
   * @param {string} userPublicKey  – base58 wallet address
   * @param {number} priorityFee    – micro-lamports per compute unit
   * @returns {Promise<VersionedTransaction>}
   */
  async buildSwapTransaction(quoteResponse, userPublicKey, priorityFee = config.solana.priorityFee) {
    const body = {
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      computeUnitPriceMicroLamports: priorityFee,
      asLegacyTransaction: false,
      dynamicComputeUnitLimit: true,
    };

    const { data } = await axios.post(`${JUP_API}/swap`, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 8000,
    });

    const txBuf = Buffer.from(data.swapTransaction, 'base64');
    return VersionedTransaction.deserialize(txBuf);
  }

  /**
   * Get price in SOL for a given token (via WSOL quote).
   * @param {string} tokenMint
   * @param {number} [decimals=6]
   * @returns {Promise<number>} price in SOL per token
   */
  async getTokenPriceInSol(tokenMint, decimals = 6) {
    try {
      const amountIn = 1_000_000; // 1 USDC-like unit for reference
      const quote = await this.getQuote(WSOL, tokenMint, LAMPORTS_PER_SOL);
      // outAmount is in token decimals
      const outAmount = parseFloat(quote.outAmount);
      return 1 / (outAmount / 10 ** decimals);
    } catch (err) {
      logger.warn('[Jupiter] getTokenPriceInSol failed', { tokenMint, err: err.message });
      return null;
    }
  }

  /**
   * Execute a full buy: quote → build tx → sign → send → confirm.
   * NOTE: Signs locally using the provided Keypair – private key never leaves process.
   *
   * @param {object} params
   * @param {string} params.tokenMint
   * @param {number} params.solAmount  – SOL (float)
   * @param {import('@solana/web3.js').Keypair} params.keypair
   * @param {boolean} [params.simulate]
   * @returns {Promise<{sig: string, inAmount: number, outAmount: number, price: number}>}
   */
  async buy({ tokenMint, solAmount, keypair, simulate = false }) {
    const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);

    logger.info('[Jupiter] BUY quote', { tokenMint, solAmount, simulate });

    const quote = await this.retryQuote(WSOL, tokenMint, lamports);
    const outTokens = parseFloat(quote.outAmount);
    const price = lamports / outTokens;

    if (simulate) {
      logger.info('[Jupiter] SIMULATE buy – no tx sent', { tokenMint, solAmount, outTokens, price });
      return { sig: 'SIMULATED', inAmount: lamports, outAmount: outTokens, price };
    }

    const tx = await this.buildSwapTransaction(quote, keypair.publicKey.toBase58());
    tx.sign([keypair]);

    const sig = await this.sendAndConfirm(tx);
    logger.info('[Jupiter] Buy confirmed', { sig, tokenMint, solAmount });
    return { sig, inAmount: lamports, outAmount: outTokens, price };
  }

  /**
   * Execute a sell.
   * @param {object} params
   * @param {string} params.tokenMint
   * @param {number} params.tokenAmount  – raw token units (already in smallest unit)
   * @param {import('@solana/web3.js').Keypair} params.keypair
   * @param {boolean} [params.simulate]
   */
  async sell({ tokenMint, tokenAmount, keypair, simulate = false }) {
    logger.info('[Jupiter] SELL quote', { tokenMint, tokenAmount, simulate });

    const quote = await this.retryQuote(tokenMint, WSOL, Math.floor(tokenAmount));
    const outLamports = parseFloat(quote.outAmount);

    if (simulate) {
      logger.info('[Jupiter] SIMULATE sell – no tx sent', { tokenMint, tokenAmount, outLamports });
      return { sig: 'SIMULATED', inAmount: tokenAmount, outAmount: outLamports };
    }

    const tx = await this.buildSwapTransaction(quote, keypair.publicKey.toBase58());
    tx.sign([keypair]);

    const sig = await this.sendAndConfirm(tx);
    logger.info('[Jupiter] Sell confirmed', { sig, tokenMint });
    return { sig, inAmount: tokenAmount, outAmount: outLamports };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  async retryQuote(inputMint, outputMint, amount, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        return await this.getQuote(inputMint, outputMint, amount);
      } catch (err) {
        if (i === retries - 1) throw err;
        await sleep(500 * (i + 1));
      }
    }
  }

  async sendAndConfirm(tx) {
    const raw = tx.serialize();
    const sig = await this.connection.sendRawTransaction(raw, {
      skipPreflight: false,
      maxRetries: config.solana.maxRetries,
      preflightCommitment: 'processed',
    });

    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();

    for (let attempt = 0; attempt < 5; attempt++) {
      const status = await this.connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        'confirmed'
      );
      if (status?.value?.err) throw new Error(`Tx failed: ${JSON.stringify(status.value.err)}`);
      if (status?.value?.err === null) return sig;
      await sleep(1000);
    }
    return sig;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = JupiterDex;
