'use strict';

/**
 * Signal Aggregator
 *
 * Consolida sinais de múltiplas fontes (KolTracker, TelegramAlpha) e
 * roteia chamadas de alta confiança para o trading engine.
 *
 * Lógica:
 *   1. Recebe 'kolSignal' e 'alphaSignal'
 *   2. Normaliza em formato único { address, ticker, confidence, sources[] }
 *   3. Janela de deduplicação: mesmo CA/ticker em 5min → merge (soma confidence)
 *   4. Multi-source bonus: CA mencionado em 2+ fontes → +15 pts confidence
 *   5. Emite 'actionableSignal' quando confidence >= threshold (default 55)
 *   6. Grava sinal no DB para análise posterior
 */

const EventEmitter = require('eventemitter3');
const { getDb }    = require('../database/db');
const logger       = require('../utils/logger');

// Minimum confidence to emit an actionable signal
const MIN_CONFIDENCE    = 55;
// Deduplication window
const DEDUP_WINDOW_MS   = 5 * 60_000;
// Multi-source bonus points
const MULTI_SOURCE_BONUS = 15;

class SignalAggregator extends EventEmitter {
  /**
   * @param {import('./kolTracker')}    kolTracker
   * @param {import('./telegramAlpha')} telegramAlpha
   */
  constructor(kolTracker, telegramAlpha) {
    super();

    // key → { address, ticker, confidence, sources, firstTs, lastTs }
    this._pending   = new Map();

    this._cleanup   = setInterval(() => this._pruneOldSignals(), 60_000);

    if (kolTracker) {
      kolTracker.on('kolSignal', sig => this._ingest(sig));
    }
    if (telegramAlpha) {
      telegramAlpha.on('alphaSignal', sig => this._ingest(sig));
    }
  }

  stop() {
    clearInterval(this._cleanup);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _ingest(raw) {
    const key = raw.address || ('TICKER:' + raw.ticker);
    if (!key || key === 'TICKER:undefined') return;

    const existing = this._pending.get(key);

    if (existing && (Date.now() - existing.firstTs) < DEDUP_WINDOW_MS) {
      // Merge: accumulate confidence, track sources
      const wasMultiSource = existing.sources.length > 1;
      if (!existing.sources.includes(raw.source)) {
        existing.sources.push(raw.source);
        // Multi-source bonus (only first time crossing 2 sources)
        if (!wasMultiSource && existing.sources.length >= 2) {
          existing.confidence = Math.min(100, existing.confidence + MULTI_SOURCE_BONUS);
          logger.info('[Agg] Multi-source confirmation', {
            key: key.slice(0, 16),
            sources: existing.sources,
            confidence: existing.confidence,
          });
        }
      }
      existing.confidence = Math.min(100, Math.max(existing.confidence, raw.confidence));
      existing.lastTs = Date.now();
      this._pending.set(key, existing);

      // Re-evaluate after merge
      this._maybeEmit(key, existing);
    } else {
      // New signal
      const entry = {
        address:    raw.address  || null,
        ticker:     raw.ticker   || null,
        confidence: raw.confidence,
        sources:    [raw.source],
        handles:    raw.handle ? [raw.handle] : [],
        tweetText:  raw.tweetText || null,
        alphaText:  raw.text || null,
        firstTs:    Date.now(),
        lastTs:     Date.now(),
        emitted:    false,
      };
      this._pending.set(key, entry);
      this._maybeEmit(key, entry);
    }
  }

  _maybeEmit(key, entry) {
    if (entry.emitted) return;
    if (entry.confidence < MIN_CONFIDENCE) return;

    entry.emitted = true;

    const signal = {
      address:    entry.address,
      ticker:     entry.ticker,
      confidence: entry.confidence,
      sources:    entry.sources,
      handles:    entry.handles,
      tweetText:  entry.tweetText,
      alphaText:  entry.alphaText,
      ts:         entry.firstTs,
    };

    logger.info('[Agg] Actionable signal', {
      address: signal.address ? signal.address.slice(0, 12) + '...' : null,
      ticker:  signal.ticker,
      confidence: signal.confidence,
      sources: signal.sources,
    });

    this._persistSignal(signal);
    this.emit('actionableSignal', signal);
  }

  _pruneOldSignals() {
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    for (const [key, entry] of this._pending.entries()) {
      if (entry.lastTs < cutoff) this._pending.delete(key);
    }
  }

  _persistSignal(signal) {
    try {
      const db = getDb();
      db.prepare(
        "INSERT INTO events (type, data) VALUES ('aggregated_signal', ?)"
      ).run(JSON.stringify(signal));
    } catch { /* non-fatal */ }
  }
}

module.exports = SignalAggregator;
