'use strict';

/**
 * RPC Manager — Multi-endpoint with latency tracking & automatic fallback
 *
 * Features:
 *   • Latency measurement per RPC (exponential moving average)
 *   • Automatic failover to next healthy endpoint
 *   • Health-check loop every 30s (discards consistently failing nodes)
 *   • Endpoint "cooldown" after consecutive failures
 *   • Always routes to lowest-latency healthy endpoint
 */

const { Connection } = require('@solana/web3.js');
const config = require('../config/config');
const logger = require('../utils/logger');

const HEALTH_CHECK_INTERVAL_MS = 30_000;
const FAILURE_COOLDOWN_MS      = 60_000;
const MAX_CONSECUTIVE_FAILURES  = 3;
const LATENCY_EMA_ALPHA         = 0.3; // weight of newest measurement

class RpcManager {
  constructor() {
    // Build per-endpoint state objects
    this._endpoints = config.solana.rpcEndpoints.map(url => ({
      url,
      connection: null,         // lazy-init
      latencyMs: 999,           // initial pessimistic estimate
      failures: 0,
      cooledDownUntil: 0,
      healthy: true,
    }));

    this._activeIdx  = 0;
    this._healthLoop = null;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Start background health-check loop */
  start() {
    this._healthLoop = setInterval(() => this._runHealthChecks(), HEALTH_CHECK_INTERVAL_MS);
    // First check immediately
    this._runHealthChecks();
  }

  stop() {
    clearInterval(this._healthLoop);
  }

  /**
   * Get the best (lowest-latency, healthy) Connection.
   * Falls back gracefully if all endpoints are unhealthy.
   */
  getConnection() {
    const best = this._pickBest();
    if (!best.connection) {
      best.connection = new Connection(best.url, {
        commitment: config.solana.commitment,
        wsEndpoint: config.solana.wsEndpoint,
        confirmTransactionInitialTimeout: 30_000,
        disableRetryOnRateLimit: false,
      });
    }
    return best.connection;
  }

  /**
   * Explicitly rotate to the next endpoint (called after tx failures).
   */
  rotateToNext() {
    const prev = this._endpoints[this._activeIdx].url;
    this._activeIdx = (this._activeIdx + 1) % this._endpoints.length;
    const next = this._endpoints[this._activeIdx].url;
    logger.warn('[RPC] Rotated endpoint', { from: prev.slice(0, 40), to: next.slice(0, 40) });
  }

  /**
   * Record a failure on the current active endpoint.
   */
  recordFailure() {
    const ep = this._endpoints[this._activeIdx];
    ep.failures += 1;
    if (ep.failures >= MAX_CONSECUTIVE_FAILURES) {
      ep.healthy = false;
      ep.cooledDownUntil = Date.now() + FAILURE_COOLDOWN_MS;
      logger.warn('[RPC] Endpoint marked unhealthy (cooldown)', { url: ep.url.slice(0, 40) });
      this.rotateToNext();
    }
  }

  /** Get current latency for display in dashboard */
  getStats() {
    return this._endpoints.map(ep => ({
      url: ep.url.replace(/\?.*/, ''), // strip API keys from URL
      latencyMs: Math.round(ep.latencyMs),
      healthy: ep.healthy,
      failures: ep.failures,
    }));
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _pickBest() {
    const now = Date.now();

    // Restore cooled-down endpoints
    for (const ep of this._endpoints) {
      if (!ep.healthy && ep.cooledDownUntil < now) {
        ep.healthy = true;
        ep.failures = 0;
        logger.info('[RPC] Endpoint restored after cooldown', { url: ep.url.slice(0, 40) });
      }
    }

    const healthy = this._endpoints.filter(ep => ep.healthy);
    if (!healthy.length) {
      logger.error('[RPC] ALL endpoints unhealthy – using first anyway');
      const first = this._endpoints[0];
      first.healthy = true;
      first.failures = 0;
      return first;
    }

    // Sort by latency
    healthy.sort((a, b) => a.latencyMs - b.latencyMs);
    this._activeIdx = this._endpoints.indexOf(healthy[0]);
    return healthy[0];
  }

  async _runHealthChecks() {
    await Promise.allSettled(
      this._endpoints.map(ep => this._checkEndpoint(ep))
    );
  }

  async _checkEndpoint(ep) {
    if (!ep.connection) {
      ep.connection = new Connection(ep.url, {
        commitment: config.solana.commitment,
        wsEndpoint: config.solana.wsEndpoint,
        confirmTransactionInitialTimeout: 30_000,
      });
    }

    const t0 = Date.now();
    try {
      await ep.connection.getSlot();
      const latency = Date.now() - t0;
      // Exponential moving average
      ep.latencyMs = ep.latencyMs * (1 - LATENCY_EMA_ALPHA) + latency * LATENCY_EMA_ALPHA;
      ep.failures = 0;
      ep.healthy   = true;
    } catch {
      ep.failures += 1;
      ep.latencyMs = 2000; // penalize
      if (ep.failures >= MAX_CONSECUTIVE_FAILURES) {
        ep.healthy = false;
        ep.cooledDownUntil = Date.now() + FAILURE_COOLDOWN_MS;
      }
    }
  }
}

// Singleton
const rpcManager = new RpcManager();
module.exports = rpcManager;
