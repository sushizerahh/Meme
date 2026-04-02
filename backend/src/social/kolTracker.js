'use strict';

/**
 * KOL Tracker — Twitter Key Opinion Leader monitor
 *
 * Monitora contas específicas de influenciadores no Twitter/X.
 * Quando um KOL confiável cita um token ($TICKER ou contract address),
 * emite um sinal de alta prioridade para o trading engine.
 *
 * Como funciona:
 *   1. Polling da timeline de cada KOL a cada 30s (sem stream)
 *   2. Detecta $TICKER e endereços Solana (base58) nos tweets
 *   3. Calcula score do KOL baseado no histórico de acertos
 *   4. Emite 'kolSignal' quando KOL confiável cita token
 *
 * Vantagem competitiva:
 *   Contas específicas têm muito mais sinal do que keywords genéricas.
 *   Um tweet de @ansemMKT ou @cryptocobain move mais mercado do que
 *   mil tweets aleatórios com "solana gem".
 */

const EventEmitter = require('eventemitter3');
const axios        = require('axios');
const config       = require('../config/config');
const { getDb }    = require('../database/db');
const logger       = require('../utils/logger');

// Regex para detectar endereço Solana (base58, 32-44 chars)
const SOLANA_ADDRESS_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
// Regex para detectar ticker
const TICKER_RE         = /\$([A-Z]{2,12})/g;

// Intervalo de polling por conta (ms) — não ultrapassar rate limit
const POLL_INTERVAL_MS  = 30_000;
// Máximo de tweets por request
const MAX_RESULTS       = 10;

class KolTracker extends EventEmitter {
  /**
   * @param {string[]} kolHandles  – lista de @handles sem o @
   *   Ex: ['ansemMKT', 'cryptocobain', 'blknoiz06']
   */
  constructor(kolHandles = []) {
    super();

    this._handles    = kolHandles;
    this._userIds    = new Map();   // handle → userId
    this._lastTweet  = new Map();   // handle → lastTweetId (para paginação)
    this._scores     = new Map();   // handle → { calls, wins, losses, score }
    this._running    = false;
    this._timers     = [];

    this._loadScores();
  }

  // ── Public ────────────────────────────────────────────────────────────────

  start() {
    if (!config.social.twitterBearerToken) {
      logger.warn('[KOL] No Twitter token — KOL tracking disabled');
      return;
    }
    if (!this._handles.length) {
      logger.warn('[KOL] No KOL handles configured — add KOL_HANDLES to .env');
      return;
    }

    this._running = true;
    logger.info('[KOL] Starting KOL tracker', { handles: this._handles });

    // Resolve user IDs first, then start polling
    this._resolveUserIds().then(() => {
      for (const handle of this._handles) {
        this._startPollingHandle(handle);
      }
    });
  }

  stop() {
    this._running = false;
    for (const timer of this._timers) clearInterval(timer);
    this._timers = [];
  }

  /**
   * Record outcome of a trade triggered by a KOL call.
   * @param {string} handle
   * @param {boolean} isWin
   */
  recordOutcome(handle, isWin) {
    const s = this._scores.get(handle) || { calls: 0, wins: 0, losses: 0 };
    s.calls++;
    if (isWin) s.wins++; else s.losses++;
    s.score = s.calls > 0 ? s.wins / s.calls : 0;
    this._scores.set(handle, s);
    this._persistScores();
    logger.debug('[KOL] Outcome recorded', { handle, isWin, score: s.score.toFixed(2) });
  }

  /**
   * Get ranked list of KOLs by win rate.
   */
  getRanking() {
    return [...this._scores.entries()]
      .map(([handle, s]) => ({ handle, ...s, winRate: (s.score * 100).toFixed(1) + '%' }))
      .sort((a, b) => b.score - a.score);
  }

  getKolScore(handle) {
    return this._scores.get(handle)?.score ?? 0.5; // default 50% if no history
  }

  // ── Private ───────────────────────────────────────────────────────────────

  async _resolveUserIds() {
    const headers = { Authorization: `Bearer ${config.social.twitterBearerToken}` };
    try {
      const usernames = this._handles.join(',');
      const { data } = await axios.get(
        `https://api.twitter.com/2/users/by?usernames=${usernames}&user.fields=public_metrics`,
        { headers, timeout: 8_000 }
      );
      for (const user of data?.data || []) {
        this._userIds.set(user.username.toLowerCase(), user.id);
        logger.debug('[KOL] Resolved user ID', { handle: user.username, id: user.id });
      }
    } catch (err) {
      const status = err.response?.status;
      if (status === 402 || status === 403 || status === 401) {
        logger.warn(
          '[KOL] Twitter API requires paid Basic plan ($100/mo) for user timeline polling. ' +
          'KOL Twitter tracking disabled. Use TELEGRAM_ALPHA_CHANNELS for free alpha signals.'
        );
        this._running = false;
      } else if (status === 429) {
        logger.warn('[KOL] Twitter rate limit hit — will retry in 15min');
        setTimeout(() => this._resolveUserIds(), 15 * 60_000);
      } else {
        logger.warn('[KOL] Failed to resolve user IDs', { err: err.message });
      }
    }
  }

  _startPollingHandle(handle) {
    // Stagger start times to avoid bursting the API
    const jitter = Math.random() * POLL_INTERVAL_MS;
    const timer  = setInterval(
      () => this._pollHandle(handle).catch(err =>
        logger.debug('[KOL] Poll error', { handle, err: err.message })
      ),
      POLL_INTERVAL_MS
    );

    // First poll after jitter
    setTimeout(() => this._pollHandle(handle), jitter);

    this._timers.push(timer);
  }

  async _pollHandle(handle) {
    if (!this._running) return;

    const userId = this._userIds.get(handle.toLowerCase());
    if (!userId) return;

    const headers = { Authorization: `Bearer ${config.social.twitterBearerToken}` };
    const params = {
      max_results: MAX_RESULTS,
      'tweet.fields': 'text,created_at,entities',
      exclude: 'retweets,replies',
    };

    // Only fetch new tweets since last poll
    const lastId = this._lastTweet.get(handle);
    if (lastId) params.since_id = lastId;

    try {
      const { data } = await axios.get(
        `https://api.twitter.com/2/users/${userId}/tweets`,
        { headers, params, timeout: 8_000 }
      );

      const tweets = data?.data || [];
      if (!tweets.length) return;

      // Update cursor
      this._lastTweet.set(handle, tweets[0].id);

      for (const tweet of tweets) {
        await this._processTweet(handle, tweet);
      }
    } catch (err) {
      const status = err.response?.status;
      if (status === 402 || status === 403) {
        logger.warn('[KOL] Twitter paid plan required — disabling KOL tracker. Use Telegram alpha instead.');
        this.stop();
      } else if (status === 429) {
        logger.warn('[KOL] Rate limited — backing off 15min', { handle });
        await new Promise(r => setTimeout(r, 15 * 60_000));
      }
    }
  }

  async _processTweet(handle, tweet) {
    const text    = tweet.text || '';
    const kolScore = this.getKolScore(handle);

    // ── Detecta endereços Solana ───────────────────────────────────────────
    const addresses = [...(text.matchAll(SOLANA_ADDRESS_RE) || [])]
      .map(m => m[0])
      .filter(addr => this._looksLikeSolanaAddress(addr));

    for (const address of addresses) {
      const signal = this._buildSignal({
        handle, tweet, address, type: 'address',
        kolScore, confidence: this._calcConfidence(handle, text, 'address'),
      });

      logger.info('[KOL] Contract address detected', {
        handle, address: address.slice(0, 12) + '...', confidence: signal.confidence,
      });

      this.emit('kolSignal', signal);
    }

    // ── Detecta tickers ($TOKEN) ───────────────────────────────────────────
    if (!addresses.length) {
      const tickers = [...(text.matchAll(TICKER_RE) || [])].map(m => m[1]);
      for (const ticker of tickers) {
        const signal = this._buildSignal({
          handle, tweet, ticker, type: 'ticker',
          kolScore, confidence: this._calcConfidence(handle, text, 'ticker'),
        });

        logger.info('[KOL] Ticker mentioned', {
          handle, ticker, confidence: signal.confidence,
        });

        this.emit('kolSignal', signal);
      }
    }
  }

  _buildSignal({ handle, tweet, address, ticker, type, kolScore, confidence }) {
    return {
      source:     'kol_twitter',
      handle,
      tweetId:    tweet.id,
      tweetText:  tweet.text,
      address,    // contract address if found
      ticker,     // $TICKER if found
      type,       // 'address' | 'ticker'
      kolScore,   // historical win rate of this KOL (0–1)
      confidence, // 0–100 composite confidence score
      ts:         Date.now(),
    };
  }

  _calcConfidence(handle, text, type) {
    const kolScore = this.getKolScore(handle);
    const calls    = this._scores.get(handle)?.calls || 0;

    // Base score from KOL win rate (0–60 pts)
    const kolPts = kolScore * 60;

    // Bonus for contract address (more specific than ticker) (+20)
    const typePts = type === 'address' ? 20 : 10;

    // Confidence in win rate (more calls = more confident)
    const confidence = Math.min(1, calls / 20);
    const confPts = confidence * 20;

    return Math.round(kolPts + typePts + confPts);
  }

  _looksLikeSolanaAddress(str) {
    // Solana addresses are base58, 32–44 chars
    // Filter out common false positives (URLs, words, etc.)
    if (str.length < 32 || str.length > 44) return false;
    if (/^[0-9]+$/.test(str)) return false;          // all numbers
    if (/^[a-zA-Z]+$/.test(str)) return false;       // all letters (word)
    if (str.includes('.') || str.includes('/')) return false; // URL fragment
    // Must have mixed case or digits typical of base58
    const hasUpper  = /[A-Z]/.test(str);
    const hasLower  = /[a-z]/.test(str);
    const hasDigit  = /[0-9]/.test(str);
    return (hasUpper && hasLower) || (hasDigit && (hasUpper || hasLower));
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  _loadScores() {
    try {
      const db  = getDb();
      const row = db.prepare("SELECT data FROM events WHERE type='kol_scores' ORDER BY ts DESC LIMIT 1").get();
      if (row) {
        const saved = JSON.parse(row.data);
        for (const [handle, score] of Object.entries(saved)) {
          this._scores.set(handle, score);
        }
        logger.debug('[KOL] Loaded scores', { count: this._scores.size });
      }
    } catch { /* DB not ready */ }
  }

  _persistScores() {
    try {
      const db  = getDb();
      const obj = Object.fromEntries(this._scores);
      db.prepare("INSERT INTO events (type, data) VALUES ('kol_scores', ?)").run(JSON.stringify(obj));
    } catch { /* non-fatal */ }
  }
}

module.exports = KolTracker;
