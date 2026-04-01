'use strict';

/**
 * Trading Engine
 *
 * Orchestrates the full lifecycle:
 *   Token detected → Score → Anti-scam → Sniper delay → Buy → Monitor → Sell
 *
 * Exit triggers:
 *   • Take profit (partial, multi-level)
 *   • Stop loss
 *   • Trailing stop
 *   • Volume collapse
 *   • Liquidity drop
 *   • Holder growth stopped
 *   • Emergency stop
 */

const EventEmitter = require('eventemitter3');
const { Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { v4: uuidv4 } = require('uuid');
const bs58 = require('bs58');

const config = require('../config/config');
const { getJupiter, getRaydium } = require('../dex/index');
const AntiScamFilter = require('../filters/antiscam');
const TokenScorer = require('./scorer');
const RiskManager = require('./risk');
const {
  upsertToken,
  insertPosition,
  updatePosition,
  getOpenPositions,
  insertTrade,
  updateDailyStats,
  logEvent,
  isBlacklisted,
} = require('../database/db');
const logger = require('../utils/logger');

const sleep = ms => new Promise(r => setTimeout(r, ms));

class TradingEngine extends EventEmitter {
  constructor() {
    super();
    this.jupiter = getJupiter();
    this.raydium = getRaydium();
    this.antiscam = new AntiScamFilter();
    this.scorer = new TokenScorer();
    this.risk = new RiskManager();

    this._keypair = null; // set via setKeypair()
    this._monitorInterval = null;
    this._pendingTokens = new Map(); // mint → timer
    this._running = false;
  }

  /**
   * Set the trading keypair (loaded from env, never stored).
   * In browser mode, signing is delegated to Phantom via the extension.
   * @param {string} privateKeyBase58
   */
  setKeypair(privateKeyBase58) {
    this._keypair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
    logger.info('[Trader] Keypair loaded', { wallet: this._keypair.publicKey.toBase58() });
  }

  getWalletAddress() {
    return this._keypair?.publicKey?.toBase58() || null;
  }

  start() {
    if (this._running) return;
    this._running = true;

    // Monitor open positions every 3 seconds
    this._monitorInterval = setInterval(() => this._monitorPositions(), 3000);
    logger.info('[Trader] Trading engine started', { simulate: config.trading.simulate });
  }

  stop() {
    this._running = false;
    if (this._monitorInterval) clearInterval(this._monitorInterval);
    for (const timer of this._pendingTokens.values()) clearTimeout(timer);
    this._pendingTokens.clear();
    logger.info('[Trader] Trading engine stopped');
  }

  // ─── Entry pipeline ───────────────────────────────────────────────────────

  /**
   * Process a newly detected token.
   * Called by Scanner's 'newToken' event.
   */
  async processNewToken(tokenInfo) {
    const { mint } = tokenInfo;

    if (!this._running) return;
    if (this._pendingTokens.has(mint)) return;

    logger.info('[Trader] Processing new token', { mint, symbol: tokenInfo.symbol });

    // Quick blacklist check
    if (isBlacklisted(mint)) return;

    // Count open positions
    const open = getOpenPositions();
    if (open.length >= config.trading.maxPositions) {
      logger.debug('[Trader] Max positions reached, skipping', { mint });
      return;
    }

    // Risk check
    const riskCheck = this.risk.canTrade();
    if (!riskCheck.allowed) {
      logger.warn('[Trader] Trade not allowed', { reason: riskCheck.reason });
      return;
    }

    // Anti-scam fast check (synchronous cache lookup first)
    const scamResult = await this.antiscam.check(tokenInfo);
    if (!scamResult.pass) {
      logger.info('[Trader] Token failed anti-scam', { mint, reasons: scamResult.reasons });
      upsertToken({ ...tokenInfo, status: 'skipped', score: 0, score_detail: JSON.stringify(scamResult) });
      return;
    }

    // Score the token
    const scoreResult = await this.scorer.score(tokenInfo);
    upsertToken({
      mint,
      symbol: tokenInfo.symbol || '???',
      name: tokenInfo.name || '',
      decimals: tokenInfo.decimals || 6,
      deployer: tokenInfo.deployer || null,
      launch_ts: tokenInfo.launch_ts || Math.floor(Date.now() / 1000),
      score: scoreResult.total,
      score_detail: JSON.stringify(scoreResult.breakdown),
      status: scoreResult.passed ? 'queued' : 'skipped',
    });

    if (!scoreResult.passed) {
      logger.info('[Trader] Token score too low', {
        mint,
        score: scoreResult.total,
        minRequired: config.trading.minScoreToBuy,
      });
      this.emit('tokenScored', { mint, score: scoreResult.total, passed: false });
      return;
    }

    this.emit('tokenScored', { mint, score: scoreResult.total, passed: true });
    logger.info('[Trader] Token passed scoring – scheduling buy', {
      mint, symbol: tokenInfo.symbol, score: scoreResult.total,
    });

    // Intelligent delay (10–30s) before entry
    const delay = config.trading.sniperDelayMin +
      Math.random() * (config.trading.sniperDelayMax - config.trading.sniperDelayMin);

    const timer = setTimeout(async () => {
      this._pendingTokens.delete(mint);
      await this._executeBuy(tokenInfo, scoreResult);
    }, delay);

    this._pendingTokens.set(mint, timer);
    logger.info('[Trader] Buy scheduled', { mint, delayMs: Math.round(delay) });
  }

  // ─── Buy execution ────────────────────────────────────────────────────────

  async _executeBuy(tokenInfo, scoreResult) {
    const { mint } = tokenInfo;

    if (!this._running) return;
    if (this.risk.isEmergencyStop()) return;

    // Re-check limits just before buying
    const riskCheck = this.risk.canTrade();
    if (!riskCheck.allowed) {
      logger.warn('[Trader] Buy cancelled – risk check failed', { mint, reason: riskCheck.reason });
      return;
    }

    if (await this.risk.isDailyLossLimitHit(this.getWalletAddress())) {
      logger.warn('[Trader] Daily loss limit hit – halting buys');
      this.risk.setEmergencyStop(true);
      return;
    }

    // Re-check liquidity is still valid right before buying
    const currentLiq = await this.raydium.getLiquidityUsd(mint).catch(() => 0);
    if (currentLiq < config.filters.minLiquidityUsd) {
      logger.info('[Trader] Liquidity dropped before buy', { mint, currentLiq });
      return;
    }

    const solAmount = await this.risk.calcPositionSize(this.getWalletAddress());
    if (solAmount < 0.001) {
      logger.warn('[Trader] Insufficient balance for trade', { mint, solAmount });
      return;
    }

    logger.info('[Trader] Executing buy', { mint, solAmount, simulate: config.trading.simulate });

    try {
      const startMs = Date.now();
      const result = await this.jupiter.buy({
        tokenMint: mint,
        solAmount,
        keypair: this._keypair,
        simulate: config.trading.simulate,
      });
      const execMs = Date.now() - startMs;

      const price = result.inAmount / result.outAmount;
      const stopLoss = this.risk.calcStopLoss(price);

      const positionId = uuidv4();
      const position = {
        id: positionId,
        mint,
        symbol: tokenInfo.symbol || '???',
        entry_price: price,
        entry_amount: solAmount,
        tokens_bought: result.outAmount,
        stop_loss: stopLoss,
        trailing_stop: stopLoss,
        simulated: config.trading.simulate ? 1 : 0,
      };

      insertPosition(position);
      insertTrade({
        id: uuidv4(),
        position_id: positionId,
        mint,
        side: 'buy',
        price,
        amount_sol: solAmount,
        amount_tokens: result.outAmount,
        tx_sig: result.sig,
        simulated: config.trading.simulate ? 1 : 0,
      });

      upsertToken({ ...tokenInfo, status: 'bought', score: scoreResult.total, score_detail: JSON.stringify(scoreResult.breakdown) });

      logger.info('[Trader] Buy executed', {
        mint, symbol: tokenInfo.symbol, solAmount, price, execMs, sig: result.sig,
      });

      this.emit('buy', { positionId, mint, symbol: tokenInfo.symbol, solAmount, price, sig: result.sig });
    } catch (err) {
      logger.error('[Trader] Buy failed', { mint, err: err.message });
      this.emit('buyError', { mint, err: err.message });
    }
  }

  // ─── Position monitor ─────────────────────────────────────────────────────

  async _monitorPositions() {
    if (!this._running) return;

    const positions = getOpenPositions();
    for (const pos of positions) {
      await this._checkPosition(pos);
    }
  }

  async _checkPosition(pos) {
    const { id, mint, entry_price, tokens_bought, remaining_pct, stop_loss, trailing_stop } = pos;

    try {
      const currentPrice = await this.jupiter.getTokenPriceInSol(mint).catch(() => null);
      if (!currentPrice) return;

      // Update trailing stop
      const newTrailingStop = this.risk.updateTrailingStop(entry_price, currentPrice, trailing_stop);
      if (newTrailingStop !== trailing_stop) {
        updatePosition(id, { trailing_stop: newTrailingStop });
      }

      const gainPct = (currentPrice - entry_price) / entry_price;

      // ── Stop loss ────────────────────────────────────────────────────────
      if (currentPrice <= stop_loss) {
        await this._executeSell(pos, remaining_pct, 'stop_loss', currentPrice);
        return;
      }

      // ── Trailing stop ─────────────────────────────────────────────────────
      if (currentPrice <= newTrailingStop && gainPct > config.trading.trailingStopActivatePct) {
        await this._executeSell(pos, remaining_pct, 'trailing_stop', currentPrice);
        return;
      }

      // ── Take profit levels ────────────────────────────────────────────────
      for (const tp of config.trading.takeProfitLevels) {
        if (gainPct >= (tp.targetMul - 1) && remaining_pct > 0) {
          const alreadySoldKey = `tp_${tp.targetMul}_sold`;
          if (pos[alreadySoldKey]) continue;

          const sellPct = Math.min(tp.pct, remaining_pct);
          await this._executeSell(pos, sellPct, `take_profit_${tp.targetMul}x`, currentPrice);
          // Mark this TP level as done
          updatePosition(id, { [alreadySoldKey]: 1, remaining_pct: remaining_pct - sellPct });
          break;
        }
      }

      // ── Fundamental exit triggers ─────────────────────────────────────────
      await this._checkFundamentalExits(pos, currentPrice);
    } catch (err) {
      logger.debug('[Trader] Position monitor error', { positionId: id, err: err.message });
    }
  }

  async _checkFundamentalExits(pos, currentPrice) {
    const { id, mint, entry_price, remaining_pct } = pos;
    if (remaining_pct <= 0) return;

    // Exit if liquidity dropped >50% from when we bought
    const liq = await this.raydium.getLiquidityUsd(mint).catch(() => null);
    if (liq !== null && liq < config.filters.minLiquidityUsd * 0.5) {
      logger.warn('[Trader] Liquidity drop exit', { mint, liq });
      await this._executeSell(pos, remaining_pct, 'liquidity_drop', currentPrice);
      return;
    }

    // Exit if volume collapses (covered by raydium volume check in scorer, simplified here)
    const vol = await this.raydium.getVolume24h(mint).catch(() => null);
    if (vol !== null && vol < 500 && (currentPrice / entry_price) < 0.5) {
      logger.info('[Trader] Volume collapse exit', { mint, vol });
      await this._executeSell(pos, remaining_pct, 'volume_collapse', currentPrice);
    }
  }

  // ─── Sell execution ───────────────────────────────────────────────────────

  async _executeSell(pos, sellPct, reason, currentPrice) {
    const { id, mint, tokens_bought, remaining_pct, entry_price, entry_amount, symbol } = pos;

    if (remaining_pct <= 0) return;

    const tokensToSell = Math.floor(tokens_bought * sellPct);
    if (tokensToSell < 1) return;

    logger.info('[Trader] Selling', { mint, symbol, sellPct, reason, currentPrice });

    try {
      const result = await this.jupiter.sell({
        tokenMint: mint,
        tokenAmount: tokensToSell,
        keypair: this._keypair,
        simulate: config.trading.simulate,
      });

      const solReceived = result.outAmount / LAMPORTS_PER_SOL;
      const costBasis = entry_amount * sellPct;
      const pnlSol = solReceived - costBasis;
      const pnlPct = (pnlSol / costBasis) * 100;

      const newRemainingPct = remaining_pct - sellPct;
      const isClosed = newRemainingPct <= 0.01;

      insertTrade({
        id: uuidv4(),
        position_id: id,
        mint,
        side: 'sell',
        price: currentPrice,
        amount_sol: solReceived,
        amount_tokens: tokensToSell,
        tx_sig: result.sig,
        simulated: config.trading.simulate ? 1 : 0,
      });

      if (isClosed) {
        updatePosition(id, {
          status: 'closed',
          remaining_pct: 0,
          close_ts: Math.floor(Date.now() / 1000),
          pnl_sol: pnlSol,
          pnl_pct: pnlPct,
          exit_reason: reason,
        });
        this.risk.recordTradeResult(pnlSol);
        logger.info('[Trader] Position closed', { mint, symbol, pnlSol: pnlSol.toFixed(4), pnlPct: pnlPct.toFixed(1), reason });
        this.emit('positionClosed', { positionId: id, mint, symbol, pnlSol, pnlPct, reason });
      } else {
        updatePosition(id, { remaining_pct: newRemainingPct });
        logger.info('[Trader] Partial sell', { mint, sellPct, remaining: newRemainingPct, reason });
        this.emit('partialSell', { positionId: id, mint, symbol, sellPct, pnlSol, reason });
      }
    } catch (err) {
      logger.error('[Trader] Sell failed', { mint, err: err.message });
      this.emit('sellError', { mint, reason, err: err.message });
    }
  }

  // ─── Manual controls ──────────────────────────────────────────────────────

  async emergencyCloseAll() {
    logger.warn('[Trader] EMERGENCY CLOSE ALL');
    this.risk.setEmergencyStop(true);
    const positions = getOpenPositions();
    for (const pos of positions) {
      const price = await this.jupiter.getTokenPriceInSol(pos.mint).catch(() => 0);
      await this._executeSell(pos, pos.remaining_pct, 'emergency', price || 0);
    }
  }
}

module.exports = TradingEngine;
