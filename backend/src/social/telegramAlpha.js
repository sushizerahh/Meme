'use strict';

/**
 * Telegram Alpha Channel Monitor
 *
 * Monitora canais Telegram de alpha (calls de tokens) com polling rápido.
 * Detecta contract addresses Solana e tickers nos mensagens.
 * Emite 'alphaSignal' para o SignalAggregator.
 *
 * Por que Telegram é melhor que Twitter para alpha:
 *   - API totalmente gratuita, sem rate limits agressivos
 *   - Canais privados de alpha postam CAs antes do pump
 *   - Menor latência que scraping Twitter com Free tier
 *   - Grupos como @solanaalpha, @dexscreener_alerts postam em ms
 *
 * Como funciona:
 *   1. Polling getUpdates a cada 500ms (long-poll timeout=1s)
 *   2. Detecta CA Solana (base58, 32-44 chars) e $TICKER
 *   3. Calcula score do canal baseado no histórico de acertos
 *   4. Deduplica: mesmo CA/ticker em 5min = ignora
 *   5. Emite 'alphaSignal' com confidence 0-100
 */

const EventEmitter = require('eventemitter3');
const axios        = require('axios');
const config       = require('../config/config');
const { getDb }    = require('../database/db');
const logger       = require('../utils/logger');

// Regex Solana address (base58, 32-44 chars)
const SOLANA_ADDR_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
// Regex ticker
const TICKER_RE      = /\$([A-Z]{2,10})/g;

// Deduplication window (ms) — ignore same CA/ticker within this window
const DEDUP_WINDOW_MS = 5 * 60_000;

// Polling interval (ms)
const POLL_INTERVAL_MS = 500;

class TelegramAlpha extends EventEmitter {
  /**
   * @param {string[]} channelIds  – IDs ou usernames dos canais a monitorar
   *   Ex: ['-1001234567890', '@solanaalpha']
   *   Se vazio, monitora TODAS mensagens que o bot recebe.
   */
  constructor(channelIds = []) {
    super();
    this._channelIds  = new Set((channelIds || []).map(String));
    this._offset      = 0;
    this._running     = false;
    this._timer       = null;

    // CA/ticker → timestamp last seen (dedup)
    this._seen        = new Map();

    // channelId → { calls, wins, losses, score }
    this._scores      = new Map();

    this._loadState();
  }

  // ── Public ────────────────────────────────────────────────────────────────

  start() {
    if (!config.social.telegramBotToken) {
      logger.warn('[TgAlpha] No Telegram token — alpha monitor disabled');
      return;
    }

    this._running = true;
    logger.info('[TgAlpha] Starting Telegram alpha monitor', {
      channels: this._channelIds.size ? [...this._channelIds] : 'all',
    });

    this._poll();
  }

  stop() {
    this._running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  /**
   * Record outcome for a channel-sourced trade.
   * @param {string} channelId
   * @param {boolean} isWin
   */
  recordOutcome(channelId, isWin) {
    const s = this._scores.get(channelId) || { calls: 0, wins: 0, losses: 0, score: 0.5 };
    s.calls++;
    if (isWin) s.wins++; else s.losses++;
    s.score = s.calls > 0 ? s.wins / s.calls : 0.5;
    this._scores.set(channelId, s);
    this._persistState();
  }

  getChannelScore(channelId) {
    return this._scores.get(channelId)?.score ?? 0.5;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  async _poll() {
    if (!this._running) return;

    try {
      const url    = `https://api.telegram.org/bot${config.social.telegramBotToken}/getUpdates`;
      const { data } = await axios.get(url, {
        params: {
          offset:           this._offset,
          timeout:          1,          // long-poll 1s
          allowed_updates:  ['message', 'channel_post'],
        },
        timeout: 5_000,
      });

      for (const upd of data?.result || []) {
        this._offset = upd.update_id + 1;
        const msg = upd.message || upd.channel_post;
        if (msg) this._processMessage(msg);
      }
    } catch (err) {
      // Network hiccup — just retry
      logger.debug('[TgAlpha] Poll error', { err: err.message });
    }

    if (this._running) {
      this._timer = setTimeout(() => this._poll(), POLL_INTERVAL_MS);
    }
  }

  _processMessage(msg) {
    const text     = msg.text || msg.caption || '';
    if (!text) return;

    const chatId   = String(msg.chat?.id || '');
    const chatName = msg.chat?.username || msg.chat?.title || chatId;

    // Filter channels if configured
    if (this._channelIds.size > 0) {
      const allowed = this._channelIds.has(chatId) ||
        (msg.chat?.username && this._channelIds.has('@' + msg.chat.username));
      if (!allowed) return;
    }

    const channelScore = this.getChannelScore(chatId);

    // ── Detect Solana contract addresses ─────────────────────────────────
    const addresses = [...(text.matchAll(SOLANA_ADDR_RE) || [])]
      .map(m => m[0])
      .filter(a => this._isValidSolanaAddress(a));

    for (const address of addresses) {
      if (this._isDuplicate(address)) continue;
      this._markSeen(address);

      const confidence = this._calcConfidence(chatId, text, 'address');
      const signal = {
        source:     'telegram_alpha',
        channelId,
        channelName: chatName,
        address,
        ticker:     null,
        type:       'address',
        channelScore,
        confidence,
        text:       text.slice(0, 280),
        ts:         Date.now(),
      };

      logger.info('[TgAlpha] CA detected', {
        channel: chatName,
        address: address.slice(0, 12) + '...',
        confidence,
      });

      this.emit('alphaSignal', signal);
    }

    // ── Detect $TICKER (only if no CA found — tickers are less reliable) ─
    if (!addresses.length) {
      const tickers = [...(text.matchAll(TICKER_RE) || [])].map(m => m[1]);
      for (const ticker of tickers) {
        const key = 'TICKER:' + ticker;
        if (this._isDuplicate(key)) continue;
        this._markSeen(key);

        const confidence = this._calcConfidence(chatId, text, 'ticker');
        const signal = {
          source:      'telegram_alpha',
          channelId,
          channelName: chatName,
          address:     null,
          ticker,
          type:        'ticker',
          channelScore,
          confidence,
          text:        text.slice(0, 280),
          ts:          Date.now(),
        };

        logger.info('[TgAlpha] Ticker mentioned', {
          channel: chatName,
          ticker,
          confidence,
        });

        this.emit('alphaSignal', signal);
      }
    }
  }

  _calcConfidence(channelId, text, type) {
    const s = this._scores.get(channelId);
    const score = s?.score ?? 0.5;
    const calls = s?.calls  ?? 0;

    // Base: channel win rate (0–55 pts)
    const basePts  = score * 55;

    // Type bonus: contract address > ticker (20 vs 10)
    const typePts  = type === 'address' ? 20 : 10;

    // Credibility from sample size (more calls = more reliable, up to 25 pts)
    const credPts  = Math.min(25, (calls / 20) * 25);

    // Urgency keywords boost (+5 each, capped at 10)
    const urgency  = ['buy', 'call', 'gem', 'alpha', '100x', 'pump', 'entry'].filter(w =>
      text.toLowerCase().includes(w)
    ).length;
    const urgPts   = Math.min(10, urgency * 5);

    return Math.round(basePts + typePts + credPts + urgPts);
  }

  _isValidSolanaAddress(str) {
    if (str.length < 32 || str.length > 44) return false;
    if (/^[0-9]+$/.test(str)) return false;
    if (/^[a-zA-Z]+$/.test(str)) return false;
    if (str.includes('.') || str.includes('/') || str.includes('@')) return false;
    const hasUpper = /[A-Z]/.test(str);
    const hasLower = /[a-z]/.test(str);
    const hasDigit = /[0-9]/.test(str);
    return (hasUpper && hasLower) || (hasDigit && (hasUpper || hasLower));
  }

  _isDuplicate(key) {
    const last = this._seen.get(key);
    return last && (Date.now() - last) < DEDUP_WINDOW_MS;
  }

  _markSeen(key) {
    this._seen.set(key, Date.now());
    // Prune old entries periodically
    if (this._seen.size > 500) {
      const cutoff = Date.now() - DEDUP_WINDOW_MS;
      for (const [k, ts] of this._seen.entries()) {
        if (ts < cutoff) this._seen.delete(k);
      }
    }
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  _loadState() {
    try {
      const db  = getDb();
      const row = db.prepare("SELECT data FROM events WHERE type='tg_alpha_scores' ORDER BY ts DESC LIMIT 1").get();
      if (row) {
        const saved = JSON.parse(row.data);
        for (const [id, score] of Object.entries(saved)) {
          this._scores.set(id, score);
        }
        logger.debug('[TgAlpha] Loaded channel scores', { count: this._scores.size });
      }
    } catch { /* DB not ready */ }
  }

  _persistState() {
    try {
      const db  = getDb();
      const obj = Object.fromEntries(this._scores);
      db.prepare("INSERT INTO events (type, data) VALUES ('tg_alpha_scores', ?)").run(JSON.stringify(obj));
    } catch { /* non-fatal */ }
  }
}

module.exports = TelegramAlpha;
