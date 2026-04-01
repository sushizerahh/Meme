'use strict';

/**
 * Social / AI Hype Monitoring Layer
 *
 * Sources monitored:
 *   • Twitter v2 API (recent search stream)
 *   • Telegram (via bot polling)
 *
 * Outputs:
 *   • Real-time mention counts per token/keyword
 *   • Sentiment score (-1 to +1)
 *   • Hype score (0–100) combining growth rate + sentiment
 *   • Narrative trend detection
 *
 * Emits events: 'hype', 'narrative' on the SocialMonitor instance.
 */

const EventEmitter = require('eventemitter3');
const axios = require('axios');
const Sentiment = require('sentiment');
const config = require('../config/config');
const { insertSocialSignal } = require('../database/db');
const logger = require('../utils/logger');

const sentiment = new Sentiment();

// Trending narrative keywords to watch globally
const NARRATIVE_KEYWORDS = [
  'solana', 'sol', 'pump', 'moon', 'gem', '100x', '1000x',
  'ai', 'depin', 'rwa', 'pepe', 'doge', 'shib', 'cat', 'dog',
  'elon', 'trump', 'grok', 'presale', 'fair launch',
];

class SocialMonitor extends EventEmitter {
  constructor() {
    super();
    this._mentionHistory = new Map(); // mint → [{ts, count}]
    this._globalTrends = new Map();   // keyword → mention count (sliding 5min window)
    this._telegramOffset = 0;
    this._twitterStreamController = null;
    this._running = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    logger.info('[Social] Starting social monitoring...');

    if (config.social.twitterBearerToken) {
      this._startTwitterStream().catch(err =>
        logger.warn('[Social] Twitter stream error', { err: err.message })
      );
    } else {
      logger.warn('[Social] No Twitter bearer token – Twitter monitoring disabled');
    }

    if (config.social.telegramBotToken) {
      this._startTelegramPolling();
    } else {
      logger.warn('[Social] No Telegram bot token – Telegram monitoring disabled');
    }

    // Periodic trend aggregation
    setInterval(() => this._aggregateTrends(), 60_000);
  }

  stop() {
    this._running = false;
    if (this._twitterStreamController) {
      this._twitterStreamController.abort();
      this._twitterStreamController = null;
    }
  }

  /**
   * Manually feed a mention (e.g. from scraping or webhook).
   * @param {string} mint
   * @param {string} source – 'twitter' | 'telegram' | 'generic'
   * @param {string[]} texts – array of post texts
   */
  ingestMentions(mint, source, texts) {
    const mentionCount = texts.length;
    const avgSentiment = texts.reduce((s, t) => s + (sentiment.analyze(t).score || 0), 0)
      / Math.max(1, texts.length);
    const normalizedSentiment = Math.max(-1, Math.min(1, avgSentiment / 5));

    this._updateMentionHistory(mint, mentionCount);
    const hypeScore = this._calcHypeScore(mint, mentionCount, normalizedSentiment);

    const signal = {
      mint,
      source,
      mentions: mentionCount,
      sentiment: normalizedSentiment,
      hype_score: hypeScore,
    };
    insertSocialSignal(signal);

    if (hypeScore >= 60) {
      this.emit('hype', { mint, hypeScore, mentionCount, sentiment: normalizedSentiment, source });
      logger.info('[Social] Hype detected', { mint, hypeScore, source });
    }

    return signal;
  }

  /**
   * Get the current hype score for a token based on cached history.
   */
  getHypeScore(mint) {
    const history = this._mentionHistory.get(mint) || [];
    if (!history.length) return 0;
    const recent = history.filter(h => Date.now() - h.ts < 5 * 60_000);
    const totalMentions = recent.reduce((s, h) => s + h.count, 0);
    return Math.min(100, Math.round(totalMentions * 2));
  }

  /**
   * Detect top trending narratives in the last 5 minutes.
   * @returns {string[]} sorted list of trending keywords
   */
  getTopNarratives() {
    return [...this._globalTrends.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([kw]) => kw);
  }

  // ─── Twitter ─────────────────────────────────────────────────────────────

  async _startTwitterStream() {
    // Twitter v2 filtered stream
    const STREAM_URL = 'https://api.twitter.com/2/tweets/search/stream';
    const RULES_URL = 'https://api.twitter.com/2/tweets/search/stream/rules';

    await this._updateStreamRules(RULES_URL);

    logger.info('[Social] Connecting to Twitter filtered stream...');

    const controller = new AbortController();
    this._twitterStreamController = controller;

    try {
      const resp = await axios.get(STREAM_URL, {
        headers: { Authorization: `Bearer ${config.social.twitterBearerToken}` },
        responseType: 'stream',
        timeout: 0, // no timeout for streams
        signal: controller.signal,
        params: { 'tweet.fields': 'text,author_id,created_at', expansions: 'author_id' },
      });

      resp.data.on('data', chunk => {
        try {
          const lines = chunk.toString().split('\n').filter(l => l.trim());
          for (const line of lines) {
            const parsed = JSON.parse(line);
            if (parsed.data) this._handleTweet(parsed.data);
          }
        } catch (_) {}
      });

      resp.data.on('end', () => {
        if (this._running) {
          logger.warn('[Social] Twitter stream ended – reconnecting in 5s');
          setTimeout(() => this._startTwitterStream(), 5000);
        }
      });
    } catch (err) {
      if (err.name !== 'AbortError') {
        logger.warn('[Social] Twitter stream error', { err: err.message });
        if (this._running) setTimeout(() => this._startTwitterStream(), 10_000);
      }
    }
  }

  async _updateStreamRules(rulesUrl) {
    const headers = { Authorization: `Bearer ${config.social.twitterBearerToken}` };
    try {
      // Delete existing rules
      const existing = await axios.get(rulesUrl, { headers });
      const ids = (existing.data?.data || []).map(r => r.id);
      if (ids.length) {
        await axios.post(rulesUrl, { delete: { ids } }, { headers });
      }

      // Add rules for Solana memecoins
      const rules = [
        { value: '(solana OR sol OR $SOL) (memecoin OR meme OR pump OR gem) lang:en -is:retweet', tag: 'sol_meme' },
        { value: 'solana new token launch -is:retweet lang:en', tag: 'sol_launch' },
      ];
      await axios.post(rulesUrl, { add: rules }, { headers });
      logger.info('[Social] Twitter stream rules updated');
    } catch (err) {
      logger.warn('[Social] Twitter rules update failed', { err: err.message });
    }
  }

  _handleTweet(tweet) {
    const text = tweet.text || '';
    const lower = text.toLowerCase();

    // Update global narrative trends
    for (const kw of NARRATIVE_KEYWORDS) {
      if (lower.includes(kw)) {
        this._globalTrends.set(kw, (this._globalTrends.get(kw) || 0) + 1);
      }
    }

    // Try to extract token ticker ($XXX)
    const tickers = text.match(/\$([A-Z]{2,10})/g) || [];
    for (const ticker of tickers) {
      const symbol = ticker.slice(1);
      const score = sentiment.analyze(text).score;
      this.emit('tweetMention', { symbol, text, sentiment: score, ts: Date.now() });
    }
  }

  // ─── Telegram ────────────────────────────────────────────────────────────

  _startTelegramPolling() {
    logger.info('[Social] Starting Telegram polling...');
    const poll = async () => {
      if (!this._running) return;
      try {
        await this._pollTelegram();
      } catch (err) {
        logger.debug('[Social] Telegram poll error', { err: err.message });
      }
      if (this._running) setTimeout(poll, 2000);
    };
    poll();
  }

  async _pollTelegram() {
    const url = `https://api.telegram.org/bot${config.social.telegramBotToken}/getUpdates`;
    const { data } = await axios.get(url, {
      params: { offset: this._telegramOffset, timeout: 10, allowed_updates: ['message', 'channel_post'] },
      timeout: 15_000,
    });

    const updates = data?.result || [];
    for (const upd of updates) {
      this._telegramOffset = upd.update_id + 1;
      const msg = upd.message || upd.channel_post;
      if (!msg?.text) continue;

      const chatId = String(msg.chat?.id || '');
      const isMonitored = config.social.telegramChannels.length === 0 ||
        config.social.telegramChannels.includes(chatId);
      if (!isMonitored) continue;

      this._handleTelegramMessage(msg.text);
    }
  }

  _handleTelegramMessage(text) {
    const lower = text.toLowerCase();

    // Update global trends
    for (const kw of NARRATIVE_KEYWORDS) {
      if (lower.includes(kw)) {
        this._globalTrends.set(kw, (this._globalTrends.get(kw) || 0) + 1);
      }
    }

    // Extract tickers
    const tickers = text.match(/\$([A-Z]{2,10})/g) || [];
    for (const ticker of tickers) {
      const symbol = ticker.slice(1);
      const score = sentiment.analyze(text).score;
      this.emit('telegramMention', { symbol, text, sentiment: score, ts: Date.now() });
    }
  }

  // ─── Aggregation ─────────────────────────────────────────────────────────

  _updateMentionHistory(mint, count) {
    if (!this._mentionHistory.has(mint)) this._mentionHistory.set(mint, []);
    const history = this._mentionHistory.get(mint);
    history.push({ ts: Date.now(), count });
    // Keep only last 30 minutes
    const cutoff = Date.now() - 30 * 60_000;
    const trimmed = history.filter(h => h.ts > cutoff);
    this._mentionHistory.set(mint, trimmed);
  }

  _calcHypeScore(mint, currentMentions, sentimentScore) {
    const history = this._mentionHistory.get(mint) || [];
    // Growth rate: compare current window vs prev window
    const now = Date.now();
    const prev5m = history.filter(h => h.ts > now - 10 * 60_000 && h.ts <= now - 5 * 60_000);
    const curr5m = history.filter(h => h.ts > now - 5 * 60_000);

    const prevCount = prev5m.reduce((s, h) => s + h.count, 0) || 1;
    const currCount = curr5m.reduce((s, h) => s + h.count, 0) + currentMentions;
    const growthRate = currCount / prevCount;

    // Hype = growth rate (0–50) + sentiment bonus (0–20) + raw mentions (0–30)
    const growthScore = Math.min(50, Math.round(growthRate * 10));
    const sentimentBonus = Math.round((sentimentScore + 1) / 2 * 20);
    const mentionsBonus = Math.min(30, currCount * 2);

    return Math.min(100, growthScore + sentimentBonus + mentionsBonus);
  }

  _aggregateTrends() {
    // Decay global trends (half-life 5 minutes)
    for (const [kw, cnt] of this._globalTrends.entries()) {
      const decayed = cnt * 0.85;
      if (decayed < 1) this._globalTrends.delete(kw);
      else this._globalTrends.set(kw, decayed);
    }

    const top = this.getTopNarratives();
    if (top.length) {
      this.emit('narrativeUpdate', { trends: top, ts: Date.now() });
      logger.debug('[Social] Top narratives', { trends: top.slice(0, 5) });
    }
  }
}

module.exports = SocialMonitor;
