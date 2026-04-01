'use strict';

/* ── State ──────────────────────────────────────────────────────────────── */
let apiUrl = 'http://127.0.0.1:3001';
let apiKey  = '';
let tradesOffset = 0;
const TRADES_PAGE = 30;
const hypeLog = [];

/* ── Boot ───────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  await loadStoredConfig();
  setupTabs();
  setupButtons();
  if (apiKey) refreshAll();
  listenToBackground();
  setInterval(refreshAll, 10_000);
});

async function loadStoredConfig() {
  const stored = await chrome.storage.local.get(['apiUrl', 'apiKey']);
  if (stored.apiUrl) apiUrl = stored.apiUrl;
  if (stored.apiKey) apiKey = stored.apiKey;
  document.getElementById('api-url').value = apiUrl;
  document.getElementById('api-key').value = apiKey;
}

/* ── Tabs ───────────────────────────────────────────────────────────────── */
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');

      // Refresh relevant data on tab switch
      if (btn.dataset.tab === 'tab-tokens') loadTokens();
      if (btn.dataset.tab === 'tab-trades') loadTrades(true);
      if (btn.dataset.tab === 'tab-hype')   loadNarratives();
    });
  });
}

/* ── Buttons ────────────────────────────────────────────────────────────── */
function setupButtons() {
  // Settings toggle
  document.getElementById('btn-settings').addEventListener('click', () => {
    document.getElementById('settings-panel').classList.toggle('hidden');
  });

  // Save connection config
  document.getElementById('btn-save-config').addEventListener('click', async () => {
    apiUrl = document.getElementById('api-url').value.trim() || apiUrl;
    apiKey = document.getElementById('api-key').value.trim() || apiKey;
    await chrome.runtime.sendMessage({ type: 'set_config', apiUrl, apiKey });
    document.getElementById('settings-panel').classList.add('hidden');
    refreshAll();
  });

  // Update trading config
  document.getElementById('btn-update-config').addEventListener('click', async () => {
    const body = {
      minScoreToBuy:    parseFloat(document.getElementById('cfg-min-score').value),
      tradeCapitalPct:  parseFloat(document.getElementById('cfg-capital-pct').value) / 100,
      stopLossPct:      parseFloat(document.getElementById('cfg-stop-loss').value) / 100,
      maxDailyLossPct:  parseFloat(document.getElementById('cfg-daily-loss').value) / 100,
    };
    const ok = Object.values(body).every(v => !isNaN(v));
    if (!ok) return alert('Invalid config values');
    await apiFetch('POST', '/api/config', body);
    showToast('Config updated');
  });

  // Token filter
  document.getElementById('token-filter').addEventListener('change', loadTokens);
  document.getElementById('btn-refresh-tokens').addEventListener('click', loadTokens);

  // Load more trades
  document.getElementById('btn-load-more').addEventListener('click', () => loadTrades(false));

  // Emergency stop
  document.getElementById('btn-emergency').addEventListener('click', async () => {
    if (!confirm('⚠ EMERGENCY STOP: Close ALL positions and halt trading?')) return;
    await apiFetch('POST', '/api/emergency-stop', { active: true });
    showToast('🛑 Emergency stop activated', 'red');
    refreshAll();
  });
}

/* ── Real-time events from background ──────────────────────────────────── */
function listenToBackground() {
  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'ws_status':
        updateWsStatus(msg.connected);
        break;
      case 'buy':
        refreshStats();
        loadPositions();
        showToast(`🟢 Bought ${msg.data?.symbol}`, 'green');
        break;
      case 'position_closed':
        refreshStats();
        loadPositions();
        const pnl = msg.data?.pnlSol;
        showToast(
          `${pnl > 0 ? '✅' : '❌'} ${msg.data?.symbol}: ${pnl?.toFixed(4)} SOL`,
          pnl > 0 ? 'green' : 'red'
        );
        break;
      case 'partial_sell':
        loadPositions();
        break;
      case 'hype':
        hypeLog.unshift({ ...msg.data, ts: Date.now() });
        if (hypeLog.length > 20) hypeLog.pop();
        renderHypeLog();
        showToast(`🔥 Hype: ${msg.data?.mint?.slice(0, 8)}...`, 'yellow');
        break;
      case 'narrative':
        renderNarratives(msg.data?.trends || []);
        break;
      case 'token_scored':
        if (msg.data?.passed) showToast(`⭐ ${msg.data.score} score – queuing buy`, 'blue');
        break;
    }
  });
}

/* ── Refresh ────────────────────────────────────────────────────────────── */
async function refreshAll() {
  await Promise.allSettled([
    refreshStats(),
    loadPositions(),
  ]);
}

async function refreshStats() {
  const [stats, status] = await Promise.allSettled([
    apiFetch('GET', '/api/stats'),
    apiFetch('GET', '/api/status'),
  ]);

  if (stats.status === 'fulfilled') renderStats(stats.value);
  if (status.status === 'fulfilled') renderStatus(status.value);
}

/* ── Render helpers ─────────────────────────────────────────────────────── */

function renderStats(data) {
  const { daily, overall, win_rate } = data;

  setText('win-rate', win_rate || 'N/A');
  document.getElementById('win-rate').className =
    'stat-value ' + (parseFloat(win_rate) >= 50 ? 'positive' : 'negative');

  const dailyPnl = daily?.total_pnl_sol || 0;
  setText('daily-pnl', `${dailyPnl >= 0 ? '+' : ''}${dailyPnl.toFixed(3)} ◎`);
  document.getElementById('daily-pnl').className = 'stat-value ' + (dailyPnl >= 0 ? 'positive' : 'negative');

  const totalPnl = overall?.total_pnl_sol || 0;
  setText('total-pnl', `${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(3)} ◎`);
  document.getElementById('total-pnl').className = 'stat-value ' + (totalPnl >= 0 ? 'positive' : 'negative');

  setText('open-count', data.open_positions || 0);
}

function renderStatus(data) {
  updateWsStatus(true); // if we got API response, backend is up
  const emgBtn = document.getElementById('btn-emergency');
  if (data.emergencyStop) {
    emgBtn.textContent = '✅ RESUME TRADING';
    emgBtn.classList.add('btn-secondary');
    emgBtn.classList.remove('btn-danger');
  } else {
    emgBtn.textContent = '⚠ EMERGENCY STOP';
    emgBtn.classList.add('btn-danger');
    emgBtn.classList.remove('btn-secondary');
  }
}

async function loadPositions() {
  const positions = await apiFetch('GET', '/api/positions').catch(() => []);
  const list = document.getElementById('positions-list');

  if (!positions.length) {
    list.innerHTML = '<div class="empty-msg">No open positions</div>';
    return;
  }

  list.innerHTML = positions.map(pos => {
    const gainPct = pos.entry_price > 0
      ? ((pos.current_price || pos.entry_price) - pos.entry_price) / pos.entry_price * 100
      : 0;
    const pnlClass = gainPct >= 0 ? 'positive' : 'negative';
    const remaining = Math.round((pos.remaining_pct || 1) * 100);

    return `
      <div class="position-card">
        <div>
          <div class="pos-symbol">${esc(pos.symbol || pos.mint?.slice(0, 8))}
            ${pos.simulated ? '<span style="color:var(--yellow);font-size:10px"> SIM</span>' : ''}
          </div>
          <div class="pos-meta">${pos.entry_amount?.toFixed(3)} ◎ entry · SL ${(pos.stop_loss * 1e6)?.toFixed(2)}</div>
        </div>
        <div>
          <div class="pos-pnl ${pnlClass}">${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(1)}%</div>
          <div class="pos-entry">${remaining}% remaining</div>
        </div>
        <div class="pos-bar-wrap">
          <div class="pos-bar">
            <div class="pos-bar-fill" style="width:${remaining}%"></div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

async function loadTokens() {
  const status = document.getElementById('token-filter').value;
  const url = `/api/tokens${status ? `?status=${status}` : ''}`;
  const tokens = await apiFetch('GET', url).catch(() => []);
  const list = document.getElementById('tokens-list');

  if (!tokens.length) {
    list.innerHTML = '<div class="empty-msg">No tokens</div>';
    return;
  }

  list.innerHTML = tokens.slice(0, 60).map(t => {
    const score = Math.round(t.score || 0);
    const scoreClass = score >= 72 ? 'score-high' : score >= 55 ? 'score-mid' : 'score-low';
    const statusClass = `status-${t.status}`;
    const liqStr = t.score_detail
      ? (() => { try { const d = JSON.parse(t.score_detail); return `$${(d.liquidity?.liquidityUsd||0).toLocaleString()}`; } catch { return ''; } })()
      : '';

    return `
      <div class="token-card">
        <div class="token-score ${scoreClass}">${score}</div>
        <div class="token-info">
          <div class="token-symbol">${esc(t.symbol || '???')} <span style="font-size:10px;color:var(--text-dim)">${esc(t.name || '')}</span></div>
          <div class="token-meta">${t.mint?.slice(0, 12)}… ${liqStr ? '· ' + liqStr : ''}</div>
        </div>
        <span class="token-status ${statusClass}">${t.status}</span>
      </div>
    `;
  }).join('');
}

async function loadTrades(reset = true) {
  if (reset) tradesOffset = 0;
  const trades = await apiFetch('GET', `/api/trades?limit=${TRADES_PAGE}&offset=${tradesOffset}`).catch(() => []);
  const list = document.getElementById('trades-list');

  if (reset) list.innerHTML = '';
  if (!trades.length) {
    if (reset) list.innerHTML = '<div class="empty-msg">No trades yet</div>';
    return;
  }

  const rows = trades.map(t => {
    const sideClass = t.side === 'buy' ? 'side-buy' : 'side-sell';
    const amtSign = t.side === 'sell' ? '+' : '-';
    const date = new Date(t.ts * 1000).toLocaleString();
    return `
      <div class="trade-row">
        <span class="trade-side ${sideClass}">${t.side.toUpperCase()}</span>
        <div class="trade-info">
          <div class="trade-symbol">${esc(t.mint?.slice(0, 8))}…</div>
          <div class="trade-meta">${date}</div>
        </div>
        <div class="trade-amount">${amtSign}${t.amount_sol?.toFixed(4)} ◎</div>
      </div>
    `;
  }).join('');

  list.insertAdjacentHTML('beforeend', rows);
  tradesOffset += trades.length;
}

async function loadNarratives() {
  const data = await apiFetch('GET', '/api/narratives').catch(() => ({ trends: [] }));
  renderNarratives(data.trends || []);
}

function renderNarratives(trends) {
  const el = document.getElementById('narratives-list');
  el.innerHTML = trends.length
    ? trends.map(t => `<span class="tag">${esc(t)}</span>`).join('')
    : '<div style="padding:10px;color:var(--text-dim);font-size:12px">No trending narratives</div>';
}

function renderHypeLog() {
  const el = document.getElementById('hype-list');
  el.innerHTML = hypeLog.map(h => `
    <div class="hype-card">
      <span class="hype-score">🔥 ${h.hypeScore}</span>
      <div>${esc(h.mint?.slice(0, 12))}…</div>
      <div style="font-size:11px;color:var(--text-dim)">${h.source || ''} · sentiment: ${h.sentiment?.toFixed(2) || '?'}</div>
    </div>
  `).join('');
}

function updateWsStatus(connected) {
  const el = document.getElementById('ws-status');
  if (connected) {
    el.textContent = '●  Online';
    el.className = 'badge badge-online';
  } else {
    el.textContent = '●  Offline';
    el.className = 'badge badge-offline';
  }
}

/* ── Utilities ──────────────────────────────────────────────────────────── */

async function apiFetch(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(apiUrl + path, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function esc(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

let toastTimer;
function showToast(msg, color = 'green') {
  const colors = { green: 'var(--green)', red: 'var(--red)', yellow: 'var(--yellow)', blue: 'var(--blue)' };
  clearTimeout(toastTimer);
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.style.cssText = `
      position:fixed; bottom:56px; left:50%; transform:translateX(-50%);
      background:var(--surface2); border:1px solid var(--border);
      padding:6px 16px; border-radius:20px; font-size:12px; font-weight:600;
      z-index:9999; white-space:nowrap; transition:opacity 0.3s;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.color = colors[color] || colors.green;
  toast.style.opacity = '1';
  toastTimer = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}
