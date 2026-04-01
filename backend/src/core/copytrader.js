'use strict';

/**
 * Copy Trading Module
 *
 * Monitors configured smart-money wallets and mirrors their token purchases,
 * subject to the same scoring and anti-scam checks.
 */

const { PublicKey } = require('@solana/web3.js');
const config = require('../config/config');
const { getConnection } = require('../dex/index');
const { isBlacklisted } = require('../database/db');
const logger = require('../utils/logger');

class CopyTrader {
  /**
   * @param {import('./trader')} tradingEngine
   */
  constructor(tradingEngine) {
    this.engine = tradingEngine;
    this.connection = getConnection();
    this._subscriptions = new Map(); // wallet → subId
    this._running = false;
  }

  start() {
    if (!config.copyTrading.enabled) {
      logger.info('[CopyTrader] Disabled');
      return;
    }
    this._running = true;
    logger.info('[CopyTrader] Starting copy trading', {
      wallets: config.copyTrading.trackedWallets,
    });

    for (const wallet of config.copyTrading.trackedWallets) {
      this._watchWallet(wallet);
    }
  }

  stop() {
    this._running = false;
    for (const [wallet, subId] of this._subscriptions.entries()) {
      this.connection.removeAccountChangeListener(subId);
    }
    this._subscriptions.clear();
    logger.info('[CopyTrader] Stopped');
  }

  addWallet(address) {
    if (!this._subscriptions.has(address)) {
      this._watchWallet(address);
      logger.info('[CopyTrader] Added wallet', { address });
    }
  }

  removeWallet(address) {
    const subId = this._subscriptions.get(address);
    if (subId) {
      this.connection.removeAccountChangeListener(subId);
      this._subscriptions.delete(address);
      logger.info('[CopyTrader] Removed wallet', { address });
    }
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _watchWallet(walletAddress) {
    try {
      const pubkey = new PublicKey(walletAddress);

      // Watch for incoming token account changes (new token purchases)
      const subId = this.connection.onLogs(
        pubkey,
        async (logs) => {
          if (!this._running) return;
          await this._handleWalletLogs(walletAddress, logs);
        },
        'confirmed'
      );

      this._subscriptions.set(walletAddress, subId);
      logger.debug('[CopyTrader] Watching wallet', { walletAddress });
    } catch (err) {
      logger.warn('[CopyTrader] Failed to watch wallet', { walletAddress, err: err.message });
    }
  }

  async _handleWalletLogs(wallet, logs) {
    // Look for token swap / buy signatures in logs
    const logText = logs.logs?.join(' ') || '';

    // Heuristic: if logs contain a Jupiter or Raydium swap instruction, parse the token
    if (!logText.includes('Program log: Instruction: Swap') &&
        !logText.includes('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8')) {
      return;
    }

    const tokenMint = await this._extractBoughtToken(wallet, logs.signature);
    if (!tokenMint) return;
    if (isBlacklisted(tokenMint)) return;

    logger.info('[CopyTrader] Wallet bought token', { wallet, tokenMint });

    // Delay slightly to avoid front-running issues with the wallet itself
    const delay = Math.random() * config.copyTrading.maxCopyDelayMs;
    await new Promise(r => setTimeout(r, delay));

    // Feed to trading engine as a new token signal
    this.engine.processNewToken({
      mint: tokenMint,
      symbol: '',
      name: '',
      source: 'copy_trade',
      copyWallet: wallet,
    }).catch(err =>
      logger.debug('[CopyTrader] processNewToken error', { err: err.message })
    );
  }

  async _extractBoughtToken(wallet, signature) {
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (!tx) return null;

      // Find post-token balances that are new or increased for the wallet
      const pre = tx.meta?.preTokenBalances || [];
      const post = tx.meta?.postTokenBalances || [];

      const walletIndex = tx.transaction.message.accountKeys
        .findIndex(k => k.pubkey.toBase58() === wallet);

      for (const postBal of post) {
        if (postBal.owner !== wallet) continue;
        const preBal = pre.find(p => p.accountIndex === postBal.accountIndex);
        const preAmount = parseFloat(preBal?.uiTokenAmount?.uiAmount || '0');
        const postAmount = parseFloat(postBal.uiTokenAmount?.uiAmount || '0');
        if (postAmount > preAmount) {
          return postBal.mint;
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}

module.exports = CopyTrader;
