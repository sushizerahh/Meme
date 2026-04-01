/**
 * Background Service Worker
 *
 * Maintains persistent WebSocket connection to the backend API.
 * Forwards real-time events to popup via chrome.runtime.sendMessage.
 * Manages API key storage and alarms for reconnection.
 */

let ws = null;
let apiUrl = 'http://127.0.0.1:3001';
let apiKey = '';
let reconnectTimer = null;
let isConnected = false;

// ── Init ────────────────────────────────────────────────────────────────────

async function init() {
  const stored = await chrome.storage.local.get(['apiUrl', 'apiKey']);
  if (stored.apiUrl) apiUrl = stored.apiUrl;
  if (stored.apiKey) apiKey = stored.apiKey;

  if (apiKey) connectWs();
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
init();

// ── WebSocket ────────────────────────────────────────────────────────────────

function connectWs() {
  if (ws) { ws.close(); ws = null; }

  const wsUrl = apiUrl.replace('http', 'ws') + `/ws?apiKey=${apiKey}`;

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      isConnected = true;
      console.log('[BG] WS connected');
      broadcastToPopup({ type: 'ws_status', connected: true });
      clearTimeout(reconnectTimer);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleEvent(msg);
      } catch (_) {}
    };

    ws.onclose = () => {
      isConnected = false;
      broadcastToPopup({ type: 'ws_status', connected: false });
      scheduleReconnect();
    };

    ws.onerror = () => {
      isConnected = false;
      scheduleReconnect();
    };
  } catch (err) {
    console.warn('[BG] WS connect error', err);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectWs, 5000);
}

// Keep service worker alive via alarm
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    if (!isConnected && apiKey) connectWs();
    // Ping WS to keep it alive
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }
});

// ── Event handling ───────────────────────────────────────────────────────────

function handleEvent(msg) {
  broadcastToPopup(msg);

  // Show browser notification for important events
  switch (msg.type) {
    case 'buy':
      showNotification(
        '🟢 Trade Opened',
        `Bought ${msg.data?.symbol} – ${msg.data?.solAmount?.toFixed(3)} SOL`
      );
      break;
    case 'position_closed':
      const pnl = msg.data?.pnlSol;
      const emoji = pnl > 0 ? '✅' : '❌';
      showNotification(
        `${emoji} Trade Closed`,
        `${msg.data?.symbol}: ${pnl > 0 ? '+' : ''}${pnl?.toFixed(4)} SOL (${msg.data?.pnlPct?.toFixed(1)}%)`
      );
      break;
    case 'hype':
      showNotification('🔥 Hype Alert', `${msg.data?.mint?.slice(0, 8)}... score: ${msg.data?.hypeScore}`);
      break;
  }
}

function broadcastToPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function showNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: '../icons/icon48.png',
    title,
    message,
  });
}

// ── Message handler (from popup) ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  switch (msg.type) {
    case 'set_config':
      apiUrl = msg.apiUrl || apiUrl;
      apiKey = msg.apiKey || apiKey;
      chrome.storage.local.set({ apiUrl, apiKey });
      connectWs();
      respond({ ok: true });
      break;

    case 'get_status':
      respond({ connected: isConnected, apiUrl, apiKeySet: !!apiKey });
      break;

    case 'reconnect':
      connectWs();
      respond({ ok: true });
      break;
  }
  return true; // async response
});
