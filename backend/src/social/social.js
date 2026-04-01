'use strict';

/**
 * Social / AI Hype Monitor
 *
 * Improvements:
 *   • Influencer detection: tracks accounts with >10k followers separately
 *   • Narrative scoring: weighted by narrative momentum (trending vs declining)
 *   • Velocity detection: mentions per minute growth rate
 *   • Multi-source aggregation: Twitter + Telegram unified score
 *   • Coordinated pump detection: sudden spike from low baseline = suspicious
 *   • Token-specific hype history for trend persistence scoring
 */

const EventEmitter = require('eventemitter3');
const axios        = require('axios');
const Sentiment    = require('sentiment');
const config       = require('../config/config');
const { insertSocialSignal } = require('../database/db');
const logger       = require('../utils/logger');

const sentiment = new Sentiment();

const NARRATIVE_KEYWORDS = [
  'solana', 'sol', 'pump', 'moon', 'gem', '100x', '1000x', 'alpha',
  'ai', 'depin', 'rwa', 'real world', 'pepe', 'doge', 'shib', 'cat', 'dog',
  'elon', 'trump', 'grok', 'new token', 'fair launch', 'presale', 'based',
  'meme', 'stealth', 'viral', 'trending', 'narrative', 'send it',
];

// Minimum follower count to classify as influencer
const INFLUENCER_FOLLOWER_MIN = 10_000;

class SocialMonitor extends EventEmitter {
  constructor() {
    super();
    // mint → Array<{ts, count, sentiment, source}>
    this._mentionHistory   = new Map();
    // keyword → rolling count (decaying)
    this._globalTrends     = new Map();
    // mint → {firstSeen, peakHype, baselineMentions}
    this._tokenProfiles    = new Map();

    this._telegramOffset   = 0;
    this._running          = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    logger.info('[Social] Starting monitors...');

    // Twitter filtered stream requires paid Basic plan (~$100/month).
    // KolTracker uses the free /2/users/{id}/tweets polling endpoint instead.
    // social.js focuses on Telegram + trend analytics only.
    if (config.social.twitterBearerToken) {
      logger.info('[Social] Twitter token present — KOL polling handled by KolTracker');
    } else {
      logger.warn('[Social] No Twitter token — Twitter disabled');
    }

    if (config.social.telegramBotToken) {
      this._startTelegramPolling();
    } else {
      logger.warn('[Social] No Telegram token — Telegram disabled');
    }

    // Trend aggregation + decay every 60s
    setInterval(() => this._aggregateTrends(), 60_000);
    // Coordinated pump detection every 2min
    setInterval(() => this._detectCoordinatedPumps(), 120_000);
  }

  stop() {
    this._running = false;
  }

  /**
   * Manually ingest mentions (e.g. from external scraper or webhook).
   */
  ingestMentions(mint, source, texts, authorFollowers = []) {
    const count       = texts.length;
    const avgSentiment = texts.reduce((s, t) => s + (sentiment.analyze(t).score || 0), 0) / Math.max(1, count);
    const normSentiment = Math.max(-1, Math.min(1, avgSentiment / 5));

    // Boost if mentions include influencers
    const influencerCount = authorFollowers.filter(f => f >= INFLUENCER_FOLLOWER_MIN).length;
    const influencerBoost = influencerCount > 0 ? 1 + (influencerCount * 0.3) : 1;

    this._updateMentionHistory(mint, count, normSentiment, source);
    const hypeScore = this._calcHypeScore(mint, count, normSentiment) * influencerBoost;
    const clampedScore = Math.min(100, hypeScore);

    // Detect suspicious coordinated pump (sudden spike from zero)
    const isSuspicious = this._isSuspiciousPump(mint, count);

    insertSocialSignal({ mint, source, mentions: count, sentiment: normSentiment, hype_score: clampedScore });

    if (clampedScore >= 60 && !isSuspicious) {
      this.emit('hype', { mint, hypeScore: clampedScore, mentionCount: count, sentiment: normSentiment, source, influencerCount });
      logger.info('[Social] Hype detected', { mint, hypeScore: clampedScore, source, influencerCount });
    } else if (isSuspicious) {
      logger.warn('[Social] Suspicious coordinated pump', { mint, count });
      this.emit('suspiciousPump', { mint, count, source });
    }

    return { hypeScore: clampedScore, isSuspicious };
  }

  getHypeScore(mint) {
    const history = this._mentionHistory.get(mint) || [];
    const recent  = history.filter(h => Date.now() - h.ts < 5 * 60_000);
    return Math.min(100, recent.reduce((s, h) => s + h.count, 0) * 2);
  }

  getTopNarratives(limit = 10) {
    return [...this._globalTrends.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([kw, score]) => ({ keyword: kw, score: Math.round(score) }));
  }

  // ── Telegram ──────────────────────────────────────────────────────────────

  _startTelegramPolling() {
    const poll = async () => {
      if (!this._running) return;
      try { await this._pollTelegram(); } catch {}
      if (this._running) setTimeout(poll, 2000);
    };
    poll();
    logger.info('[Social] Telegram polling started');
  }

  async _pollTelegram() {
    const url = `https://api.telegram.org/bot${config.social.telegramBotToken}/getUpdates`;
    const { data } = await axios.get(url, {
      params: { offset: this._telegramOffset, timeout: 10, allowed_updates: ['message', 'channel_post'] },
      timeout: 15_000,
    });

    for (const upd of data?.result || []) {
      this._telegramOffset = upd.update_id + 1;
      const msg = upd.message || upd.channel_post;
      if (!msg?.text) continue;

      const chatId = String(msg.chat?.id || '');
      const isMonitored = !config.social.telegramChannels?.length ||
        config.social.telegramChannels.includes(chatId);
      if (!isMonitored) continue;

      this._handleTelegramMessage(msg.text, msg.from);
    }
  }

  _handleTelegramMessage(text, from) {
    const lower = text.toLowerCase();

    for (const kw of NARRATIVE_KEYWORDS) {
      if (lower.includes(kw)) {
        this._globalTrends.set(kw, (this._globalTrends.get(kw) || 0) + 1);
      }
    }

    const tickers = text.match(/\$([A-Z]{2,12})/g) || [];
    for (const ticker of tickers) {
      const symbol = ticker.slice(1);
      const score  = sentiment.analyze(text).score;
      this.emit('telegramMention', { symbol, text, sentiment: score, ts: Date.now() });
    }
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  _updateMentionHistory(mint, count, sentimentScore, source) {
    if (!this._mentionHistory.has(mint)) this._mentionHistory.set(mint, []);
    const hist = this._mentionHistory.get(mint);
    hist.push({ ts: Date.now(), count, sentiment: sentimentScore, source });

    // Keep 30-minute window
    const cutoff = Date.now() - 30 * 60_000;
    this._mentionHistory.set(mint, hist.filter(h => h.ts > cutoff));
  }

  _calcHypeScore(mint, currentCount, sentimentScore) {
    const history = this._mentionHistory.get(mint) || [];
    const now     = Date.now();

    const prev5m  = history.filter(h => h.ts > now - 10 * 60_000 && h.ts <= now - 5 * 60_000);
    const curr5m  = history.filter(h => h.ts > now - 5 * 60_000);

    const prevCount = prev5m.reduce((s, h) => s + h.count, 0) || 1;
    const currCount = curr5m.reduce((s, h) => s + h.count, 0) + currentCount;

    const growthRate     = currCount / prevCount;
    const growthScore    = Math.min(50, Math.round(growthRate * 10));
    const sentimentBonus = Math.round((sentimentScore + 1) / 2 * 20);
    const mentionsBonus  = Math.min(30, currCount * 2);

    return growthScore + sentimentBonus + mentionsBonus;
  }

  _isSuspiciousPump(mint, currentCount) {
    const profile = this._tokenProfiles.get(mint);
    if (!profile) {
      this._tokenProfiles.set(mint, {
        firstSeen: Date.now(),
        baselineMentions: currentCount,
        peakHype: currentCount,
      });
      return false;
    }

    // If baseline was 0 and suddenly we get 50+ mentions → suspicious
    const ratio = profile.baselineMentions < 2
      ? currentCount
      : currentCount / profile.baselineMentions;

    return ratio > 20 && profile.baselineMentions < 5;
  }

  _aggregateTrends() {
    // Decay with half-life ~5min
    for (const [kw, cnt] of this._globalTrends.entries()) {
      const decayed = cnt * 0.85;
      if (decayed < 1) this._globalTrends.delete(kw);
      else this._globalTrends.set(kw, decayed);
    }

    const top = this.getTopNarratives(5);
    if (top.length) {
      this.emit('narrativeUpdate', { trends: top.map(t => t.keyword), ts: Date.now() });
      logger.debug('[Social] Narratives', { top: top.slice(0, 3) });
    }
  }

  _detectCoordinatedPumps() {
    for (const [mint, history] of this._mentionHistory.entries()) {
      if (!history.length) continue;

      // Check for sudden concentration of mentions in a short window
      const last2m = history.filter(h => Date.now() - h.ts < 2 * 60_000);
      const total  = last2m.reduce((s, h) => s + h.count, 0);

      if (total > 50) {
        // Check if all mentions came from one source = coordinated
        const sources = new Set(last2m.map(h => h.source));
        if (sources.size === 1) {
          this.emit('suspiciousPump', { mint, totalMentions: total, source: [...sources][0] });
          logger.warn('[Social] Concentrated single-source pump', { mint, total });
        }
      }
    }
  }
}

module.exports = SocialMonitor;
