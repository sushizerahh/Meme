'use strict';

/**
 * Backtesting Engine
 *
 * Replays historical trade data from the database and calculates:
 *   • Win rate
 *   • Average P&L
 *   • Max drawdown
 *   • Sharpe ratio approximation
 *   • Best/worst trades
 *
 * Run: node src/core/backtest.js
 */

require('dotenv').config();
const { getDb, getStats } = require('../database/db');

function runBacktest() {
  const db = getDb();

  const trades = db.prepare(`
    SELECT p.*, t.ts as trade_ts
    FROM positions p
    LEFT JOIN trades t ON t.position_id = p.id AND t.side = 'buy'
    WHERE p.status = 'closed'
    ORDER BY p.close_ts ASC
  `).all();

  if (!trades.length) {
    console.log('No closed positions found for backtest.');
    process.exit(0);
  }

  let wins = 0, losses = 0, totalPnl = 0;
  let peak = 0, drawdown = 0, maxDrawdown = 0;
  const pnls = [];

  for (const t of trades) {
    const pnl = t.pnl_sol || 0;
    pnls.push(pnl);
    totalPnl += pnl;
    if (pnl > 0) wins++;
    else losses++;

    peak = Math.max(peak, totalPnl);
    drawdown = peak - totalPnl;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  const total = trades.length;
  const winRate = (wins / total * 100).toFixed(1);
  const avgPnl = (totalPnl / total).toFixed(4);
  const avgWin = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0) / Math.max(wins, 1);
  const avgLoss = pnls.filter(p => p < 0).reduce((a, b) => a + b, 0) / Math.max(losses, 1);
  const profitFactor = Math.abs(avgWin * wins) / Math.max(Math.abs(avgLoss * losses), 0.0001);

  // Sharpe ratio (simplified, daily)
  const mean = totalPnl / total;
  const variance = pnls.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / total;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (mean / stdDev).toFixed(2) : 'N/A';

  console.log('\n═══════════════════════════════════════════');
  console.log('       SOLANA MEME TRADER – BACKTEST        ');
  console.log('═══════════════════════════════════════════');
  console.log(`Total trades   : ${total}`);
  console.log(`Win rate       : ${winRate}%`);
  console.log(`Total P&L      : ${totalPnl.toFixed(4)} SOL`);
  console.log(`Avg P&L/trade  : ${avgPnl} SOL`);
  console.log(`Avg win        : ${avgWin.toFixed(4)} SOL`);
  console.log(`Avg loss       : ${avgLoss.toFixed(4)} SOL`);
  console.log(`Profit factor  : ${profitFactor.toFixed(2)}`);
  console.log(`Max drawdown   : ${maxDrawdown.toFixed(4)} SOL`);
  console.log(`Sharpe ratio   : ${sharpe}`);
  console.log('───────────────────────────────────────────');

  const best = trades.reduce((b, t) => t.pnl_sol > (b?.pnl_sol || -Infinity) ? t : b, null);
  const worst = trades.reduce((w, t) => t.pnl_sol < (w?.pnl_sol || Infinity) ? t : w, null);
  console.log(`Best trade     : ${best?.symbol} +${best?.pnl_sol?.toFixed(4)} SOL (${best?.exit_reason})`);
  console.log(`Worst trade    : ${worst?.symbol} ${worst?.pnl_sol?.toFixed(4)} SOL (${worst?.exit_reason})`);
  console.log('═══════════════════════════════════════════\n');
}

if (require.main === module) runBacktest();
module.exports = { runBacktest };
