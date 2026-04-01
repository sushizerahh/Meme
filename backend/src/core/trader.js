'use strict';

/**
 * Trading Engine — Thin orchestration layer
 *
 * Delegates ALL decision making to DecisionEngine.
 * Delegates ALL exit logic to ExitStrategy.
 * This file is responsible for:
 *   • Coordinating the pipeline (scanner → decision → buy → monitor → exit)
 *   • Executing Jupiter swaps
 *   • Persisting positions & trades to DB
 *   • Emitting events for the API/dashboard
 */

const EventEmitter   = require('eventemitter3');
const { Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { v4: uuidv4 } = require('uuid');
const bs58           = require('bs58');

const config         = require('../config/config');
const DecisionEngine = require('./decisionEngine');
const ExitStrategy   = require('./exitStrategy');
const RiskManager    = require('./risk');
const { getJupiter, getRaydium } = require('../dex/index');
const {
  upsertToken, insertPosition, updatePosition,
  getOpenPositions, insertTrade, logEvent, isBlacklisted,
} = require('../database/db');
const logger = require('../utils/logger');

const { DECISION } = DecisionEngine;
const sleep = ms => new Promise(r => setTimeout(r, ms));

class TradingEngine extends EventEmitter {
  constructor() {
    super();
    this.risk     = new RiskManager();
    this.decision = new DecisionEngine(this.risk);
    this.exit     = new ExitStrategy(this.risk);
    this.jupiter  = getJupiter();
    this.raydium  = getRaydium();

    this._keypair         = null;
    this._monitorInterval = null;
    this._inProgress      = new Set(); // mints currently being evaluated
    this._running         = false;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  setKeypair(privateKeyBase58) {
    this._keypair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
    logger.info('[Trader] Wallet loaded', { address: this._keypair.publicKey.toBase58() });
  }

  getWalletAddress() {
    return this._keypair?.publicKey?.toBase58() ?? null;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._monitorInterval = setInterval(() => this._monitorPositions(), 3_000);
    logger.info('[Trader] Engine started', { simulate: config.trading.simulate });
  }

  stop() {
    this._running = false;
    if (this._monitorInterval) clearInterval(this._monitorInterval);
    logger.info('[Trader] Engine stopped');
  }

  // ── Entry pipeline ────────────────────────────────────────────────────────

  /**
   * Process a newly detected token through the full pipeline.
   * Called by Scanner and CopyTrader.
   */
  async processNewToken(tokenInfo) {
    const { mint } = tokenInfo;
    if (!this._running)          return;
    if (this._inProgress.has(mint)) return; // already being evaluated
    this._inProgress.add(mint);

    try {
      // Persist token to DB (status: watching)
      upsertToken({
        mint,
        symbol:       tokenInfo.symbol || '???',
        name:         tokenInfo.name   || '',
        decimals:     tokenInfo.decimals || 6,
        deployer:     tokenInfo.deployer || null,
        launch_ts:    tokenInfo.launch_ts || Math.floor(Date.now() / 1000),
        score:        null,
        score_detail: null,
        status:       'watching',
      });

      // Full decision pipeline (includes delay + re-validation)
      const result = await this.decision.evaluate(tokenInfo);

      // Update DB with decision outcome
      upsertToken({
        mint,
        symbol:       tokenInfo.symbol || '???',
        name:         tokenInfo.name   || '',
        decimals:     tokenInfo.decimals || 6,
        deployer:     tokenInfo.deployer || null,
        launch_ts:    tokenInfo.launch_ts || Math.floor(Date.now() / 1000),
        score:        result.score?.total ?? null,
        score_detail: result.score ? JSON.stringify(result.score.breakdown) : null,
        status:       result.decision === DECISION.BUY ? 'queued' : 'skipped',
      });

      this.emit('tokenScored', {
        mint,
        symbol:   tokenInfo.symbol,
        score:    result.score?.total,
        decision: result.decision,
        reason:   result.reason,
      });

      if (result.decision === DECISION.HALT) {
        logger.warn('[Trader] System halt from DecisionEngine', { reason: result.reason });
        return;
      }

      if (result.decision !== DECISION.BUY) {
        logger.debug('[Trader] Token rejected', { mint, decision: result.decision, reason: result.reason });
        return;
      }

      // Execute buy
      await this._executeBuy(tokenInfo, result);

    } catch (err) {
      logger.error('[Trader] processNewToken error', { mint, err: err.message });
    } finally {
      this._inProgress.delete(mint);
    }
  }

  // ── Buy ────────────────────────────────────────────────────────────────────

  async _executeBuy(tokenInfo, decisionResult) {
    const { mint } = tokenInfo;

    // Final balance / daily loss check
    if (await this.risk.isDailyLossLimitHit(this.getWalletAddress())) {
      logger.warn('[Trader] Daily loss limit — halting');
      this.risk.setEmergencyStop(true);
      return;
    }

    const solAmount = await this.risk.calcPositionSize(this.getWalletAddress());
    if (solAmount < 0.001) {
      logger.warn('[Trader] Insufficient balance', { solAmount });
      return;
    }

    try {
      const buyResult = await this.jupiter.buy({
        tokenMint:    mint,
        solAmount,
        keypair:      this._keypair,
        liquidityUsd: decisionResult.liquidityUsd,
        simulate:     config.trading.simulate,
      });

      const price     = buyResult.inAmount / buyResult.outAmount;
      const stopLoss  = this.exit.calcInitialStopLoss(price);
      const posId     = uuidv4();

      const position = {
        id:            posId,
        mint,
        symbol:        tokenInfo.symbol || '???',
        entry_price:   price,
        entry_amount:  solAmount,
        entry_liq_usd: decisionResult.liquidityUsd || 0,
        tokens_bought: buyResult.outAmount,
        remaining_pct: 1.0,
        stop_loss:     stopLoss,
        trailing_stop: stopLoss,
        simulated:     config.trading.simulate ? 1 : 0,
      };

      insertPosition(position);
      insertTrade({
        id:            uuidv4(),
        position_id:   posId,
        mint,
        side:          'buy',
        price,
        amount_sol:    solAmount,
        amount_tokens: buyResult.outAmount,
        tx_sig:        buyResult.sig,
        simulated:     config.trading.simulate ? 1 : 0,
      });

      upsertToken({ ...tokenInfo, status: 'bought' });

      logger.info('[Trader] Position opened', {
        mint, symbol: tokenInfo.symbol,
        solAmount, price,
        latencyMs: buyResult.latencyMs,
        slippageBps: buyResult.slippageBps,
        sig: buyResult.sig,
      });

      this.emit('buy', {
        positionId: posId, mint,
        symbol: tokenInfo.symbol,
        solAmount, price,
        sig: buyResult.sig,
        latencyMs: buyResult.latencyMs,
      });

    } catch (err) {
      logger.error('[Trader] Buy failed', { mint, err: err.message });
      this.emit('buyError', { mint, err: err.message });
    }
  }

  // ── Position monitor ───────────────────────────────────────────────────────

  async _monitorPositions() {
    if (!this._running) return;
    const positions = getOpenPositions();
    await Promise.allSettled(positions.map(pos => this._checkPosition(pos)));
  }

  async _checkPosition(pos) {
    try {
      // Fetch current price and pool info in parallel
      const [currentPrice, poolInfo] = await Promise.allSettled([
        this.jupiter.getTokenPriceInSol(pos.mint),
        this.raydium.getPoolInfo(pos.mint),
      ]);

      const price = currentPrice.status === 'fulfilled' ? currentPrice.value : null;
      const pool  = poolInfo.status  === 'fulfilled' ? poolInfo.value  : null;

      if (!price) return;

      // Delegate to exit strategy
      const signal = await this.exit.evaluate(pos, price, pool);
      if (!signal || signal.trigger === 'hold') {
        // Only update trailing stop if it changed
        if (signal?.newTrailingStop && signal.newTrailingStop !== pos.trailing_stop) {
          updatePosition(pos.id, { trailing_stop: signal.newTrailingStop });
        }
        return;
      }

      if (signal.sellPct > 0) {
        await this._executeSell(pos, signal, price);
      }
    } catch (err) {
      logger.debug('[Trader] Position monitor error', { posId: pos.id, err: err.message });
    }
  }

  // ── Sell ───────────────────────────────────────────────────────────────────

  async _executeSell(pos, signal, currentPrice) {
    const { id, mint, tokens_bought, remaining_pct, entry_amount, entry_price, symbol } = pos;
    const { trigger, sellPct, urgency, tpLevelIndex, newTrailingStop } = signal;

    const tokensToSell = Math.floor(tokens_bought * sellPct);
    if (tokensToSell < 1) return;

    try {
      const sellResult = await this.jupiter.sell({
        tokenMint:    mint,
        tokenAmount:  tokensToSell,
        keypair:      this._keypair,
        liquidityUsd: pos.entry_liq_usd,
        simulate:     config.trading.simulate,
      });

      const solReceived   = sellResult.outAmount / LAMPORTS_PER_SOL;
      const costBasis     = entry_amount * sellPct;
      const pnlSol        = solReceived - costBasis;
      const pnlPct        = costBasis > 0 ? (pnlSol / costBasis) * 100 : 0;
      const newRemaining  = Math.max(0, remaining_pct - sellPct);
      const isClosed      = newRemaining <= 0.01;

      insertTrade({
        id:            uuidv4(),
        position_id:   id,
        mint,
        side:          'sell',
        price:         currentPrice,
        amount_sol:    solReceived,
        amount_tokens: tokensToSell,
        tx_sig:        sellResult.sig,
        simulated:     config.trading.simulate ? 1 : 0,
      });

      const posUpdates = {
        remaining_pct: newRemaining,
        trailing_stop: newTrailingStop ?? pos.trailing_stop,
      };

      // Mark TP level as sold
      if (tpLevelIndex !== undefined) {
        posUpdates[`tp_${tpLevelIndex}_sold`] = 1;
      }

      if (isClosed) {
        Object.assign(posUpdates, {
          status:      'closed',
          close_ts:    Math.floor(Date.now() / 1000),
          pnl_sol:     pnlSol,
          pnl_pct:     pnlPct,
          exit_reason: trigger,
        });
        this.risk.recordTradeResult(pnlSol);

        // Feed outcome back to scorer for adaptive learning
        if (pos.score_detail) {
          try {
            const breakdown = JSON.parse(pos.score_detail);
            this.decision.scorer.updateWeightsFromOutcome(breakdown, pnlSol > 0);
          } catch { /* non-fatal */ }
        }

        logger.info(`[Trader] Position closed ${pnlSol > 0 ? '✅' : '❌'}`, {
          symbol, pnlSol: pnlSol.toFixed(4), pnlPct: pnlPct.toFixed(1) + '%', trigger,
        });
        this.emit('positionClosed', { positionId: id, mint, symbol, pnlSol, pnlPct, trigger });
      } else {
        logger.info('[Trader] Partial sell', { symbol, sellPct: (sellPct * 100).toFixed(0) + '%', trigger, solReceived: solReceived.toFixed(4) });
        this.emit('partialSell', { positionId: id, mint, symbol, sellPct, pnlSol, trigger });
      }

      updatePosition(id, posUpdates);

    } catch (err) {
      logger.error('[Trader] Sell failed', { mint, trigger, err: err.message });
      this.emit('sellError', { mint, trigger, err: err.message });
    }
  }

  // ── Emergency ──────────────────────────────────────────────────────────────

  async emergencyCloseAll() {
    logger.warn('[Trader] EMERGENCY CLOSE ALL POSITIONS');
    this.risk.setEmergencyStop(true);

    const positions = getOpenPositions();
    for (const pos of positions) {
      const price = await this.jupiter.getTokenPriceInSol(pos.mint).catch(() => 0);
      await this._executeSell(pos, {
        trigger: 'emergency',
        sellPct: pos.remaining_pct,
        urgency: 'emergency',
      }, price || 0);
    }
  }
}

module.exports = TradingEngine;
