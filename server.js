const express  = require('express');
const { WebSocketServer } = require('ws');
const path     = require('path');
const https    = require('https');
const http     = require('http');
const os       = require('os');
const cors = require('cors');
const app  = express();
const PORT = 3000;
app.use(cors());
// ── Album art proxy ──────────────────────────────────────────────────────────
app.get('/albumart', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('No URL');

  const client = url.startsWith('https') ? https : http;
  const request = client.get(url, { timeout: 5000 }, (imgRes) => {
    if (imgRes.statusCode !== 200)
      return res.status(502).send('Bad upstream');
    res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    imgRes.pipe(res);
  });
  request.on('timeout', () => { request.destroy(); if (!res.headersSent) res.status(504).send('Timeout'); });
  request.on('error',   (e) => { console.error('Art error:', e.message); if (!res.headersSent) res.status(500).send('Error'); });
});

// ── Status page ──────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  const displays  = [...wss.clients].filter(c => c.role === 'display' && c.readyState === 1).length;
  const spicetify = [...wss.clients].filter(c => c.role === 'spicetify' && c.readyState === 1).length;
  res.json({
    uptime:          Math.round(process.uptime()) + 's',
    displays:        displays,
    spicetifyBridge: spicetify,
    track:           currentState.trackName || 'none',
    artist:          currentState.artist || 'none',
    lyricsSource:    lastFullLyrics?.lyricsSource || 'none',
    lyricsLines:     lastFullLyrics?.lines?.length || 0,
    syncType:        lastFullLyrics?.syncType || 'none',
    positionMs:      currentState.positionMs || 0,
  });
});

// ── Display page ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'display.html'));
});
// MIDDLE OF FILE
// before app.listen() or server.listen()

async function proxy(req, res, endpoint) {
  try {
    const url =
      `https://lrclib.net/api/${endpoint}?` +
      new URLSearchParams(req.query).toString();

    const r = await fetch(url);

    const text = await r.text();

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(r.status).send(text);

  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
}

app.get('/lrclib/get', (req, res) => {
  proxy(req, res, 'get');
});

app.get('/lrclib/search', (req, res) => {
  proxy(req, res, 'search');
});
// ── Server ───────────────────────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔════════════════════════════════╗');
  console.log('║      Shower Lyrics Server      ║');
  console.log('╠════════════════════════════════╣');
  console.log(`║  Local:   http://localhost:${PORT}  ║`);
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log(`║  Network: http://${iface.address}:${PORT}   ║`);
      }
    }
  }
  console.log('║  Status:  /status              ║');
  console.log('╚════════════════════════════════╝\n');
});

// ── State ────────────────────────────────────────────────────────────────────
let currentState = {
  type:      'line',
  lyric:     '',
  albumArt:  '',
  trackName: '',
  artist:    ''
};

let lastFullLyrics = null;

// ── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

const PING_INTERVAL = 20000;
const PING_TIMEOUT  = 10000;

function heartbeat() { this.isAlive = true; }

const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log(`[WS] Client timed out (${ws.role || 'unknown'}), terminating`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, PING_INTERVAL);

wss.on('close', () => clearInterval(pingInterval));

function broadcast(data, exclude = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client !== exclude && client.role === 'display' && client.readyState === 1) {
      try { client.send(msg); } catch (e) { console.error('[WS] Broadcast error:', e.message); }
    }
  });
}

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  ws.isAlive = true;
  ws.role    = 'display'; // default — bridge will identify itself
  ws.on('pong', heartbeat);

  console.log(`[WS] Connected: ${ip}`);

  // Send best available state immediately
  try {
    const toSend = lastFullLyrics || currentState;
    ws.send(JSON.stringify(toSend));
  } catch (e) {
    console.error('[WS] Failed to send initial state:', e.message);
  }

  ws.on('message', (data) => {
    let parsed;
    try { parsed = JSON.parse(data); }
    catch (e) { console.error('[WS] Bad JSON:', e.message); return; }

    // Identify bridge connections
    if (parsed.source === 'spicetify') {
      ws.role = 'spicetify';

      // Update state based on message type
      if (parsed.type === 'fullLyrics') {
        lastFullLyrics = parsed;
        currentState   = parsed;
        console.log(`[Lyrics] ${parsed.trackName} — ${parsed.artist} | ${parsed.lyricsSource} | ${parsed.lines?.length} lines`);
      } else if (parsed.type === 'position') {
        currentState.positionMs = parsed.positionMs;
      } else if (parsed.type === 'playpause') {
        currentState.playing   = parsed.playing;
        currentState.positionMs = parsed.positionMs;
        console.log(`[Player] ${parsed.playing ? '▶ Playing' : '⏸ Paused'}`);
      } else if (parsed.type === 'line') {
        if (parsed.lyric === '') {
          lastFullLyrics = null;
          console.log('[Lyrics] Cleared (song change)');
        }
        currentState = parsed;
      } else if (parsed.type !== 'wordupdate') {
        currentState = parsed;
      }

      // Broadcast everything except wordupdate to display clients
      // wordupdate still goes through for word highlight sync
      broadcast(parsed, ws);
    }
  });

  ws.on('error', (err) => console.error(`[WS] Error (${ip}):`, err.message));
  ws.on('close', (code) => console.log(`[WS] Disconnected: ${ip} (${ws.role}, code ${code})`));
});
// VERY BOTTOM OF FILE
// add this BELOW everything else

// ── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');
  clearInterval(pingInterval);
  wss.clients.forEach(ws => ws.terminate());
  server.close(() => process.exit(0));
});