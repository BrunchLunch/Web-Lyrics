# Shower Lyrics — Project Context

Handoff document. Covers what the project is, how it's structured, what was changed, and what still needs verification.

---

## What This Is

A real-time Spotify lyrics display, designed to show synced song lyrics on a browser page — typically an iPad mounted in a shower. Lyrics scroll and highlight in time with the music without any manual input.

### How it works (end-to-end)

```
Spotify (desktop app)
  └── Spicetify extension (shower-bridge.js)
        ├── fetches synced lyrics from LRCLIB API (4-tier fallback)
        ├── falls back to Spotify's internal lyrics API
        └── streams everything over WebSocket
              └── Node.js server (server.js, port 3000)
                    ├── routes messages to display clients
                    ├── proxies album art (CORS workaround)
                    └── proxies LRCLIB API calls (CORS workaround)
                          └── Browser display page (display.html)
                                ├── renders all lyric lines with distance-based opacity
                                ├── advances active line by tracking playback position
                                └── animates word-level highlights (when available)
```

### Lyrics sources (priority order)

1. **LRCLIB exact match** — artist + track + album + duration
2. **LRCLIB search** — artist + track name
3. **LRCLIB generic query** — `"artist track"` string
4. **Spotify internal API** — always available but may be unsynced (`UNSYNCED` syncType)

---

## File Map

| File | Location | Role |
|---|---|---|
| `server.js` | repo root | Express + WebSocket server. Runs with `node server.js` |
| `display.html` | repo root | Browser display page. Served at `http://localhost:3000` |
| `shower-bridge.js` | repo root | Spicetify extension source (edit here) |
| `package.json` / `package-lock.json` | repo root | Node dependencies (`express`, `ws`) |
| `lrclib-proxy.js` | repo root | Old standalone proxy on port 3001 — superseded, kept for reference only |
| `.gitignore` | repo root | Excludes `node_modules/`, `*.rar`, `Extra'/` |

### Spicetify symlink

```
C:\Users\ryana\AppData\Roaming\spicetify\Extensions\shower-bridge.js
  → C:\Users\ryana\Desktop\CodeTest\shower-bridge.js  (symlink)
```

Spicetify **must** load its extensions from that AppData path. The symlink means you edit `shower-bridge.js` in the repo, then run `spicetify apply` — no manual copying needed.

### Old source folder

`C:\Users\ryana\shower-lyrics\` still exists as a backup. All files from it have been copied into the repo. Safe to delete once the app is confirmed working from the repo.

---

## Running the App

**Start the server:**
```powershell
cd C:\Users\ryana\Desktop\CodeTest
node server.js
```

**After editing `shower-bridge.js`:**
```powershell
spicetify apply
```

**Check server health:**
```
http://localhost:3000/status
```
Returns JSON with connected client counts, current track, lyrics source, line count, etc.

**Display page:**
```
http://localhost:3000
```
Open on any device on the same WiFi network using the machine's local IP (printed to console on server start).

---

## Bug Fixed: `fullLyrics` Messages Never Reached the Display

### Symptom

The bridge logged `[ShowerBridge] Lyrics from: lrclib-exact` confirming lyrics were fetched, but the display browser page only ever received `position` and `wordupdate` messages — never `fullLyrics`. The display showed nothing.

### Root cause

A JavaScript object spread collision in `shower-bridge.js`.

The `send()` wrapper stamps every outgoing message with `source: 'spicetify'` so the server can identify bridge traffic:

```js
function send(data) {
  ws.send(JSON.stringify({ source: 'spicetify', ...data }));
}
```

The `fullLyrics` call passed its own `source` field (the lyrics-provider name like `'lrclib-exact'`) inside the data object:

```js
send({
  type: 'fullLyrics',
  lines, syncType,
  source,          // spread AFTER 'spicetify' — overwrites it
  positionMs: ...,
  ...getTrackInfo()
});
```

The wire message became `{ "source": "lrclib-exact", "type": "fullLyrics", ... }`. The server checks `if (parsed.source === 'spicetify')` — this check **failed**, so the entire handler block was skipped: `lastFullLyrics` was never stored, the message was never broadcast to display clients.

`position` and `wordupdate` worked fine because their send calls don't include a `source` field, so `source: 'spicetify'` survived.

### Fix — rename the lyrics-provider field to `lyricsSource`

Three files changed, one field renamed:

**`shower-bridge.js` line 339:**
```js
// Before
source,
// After
lyricsSource: source,
```

**`server.js` line 38** (status route) and **line 167** (log):
```js
// Before
lastFullLyrics?.source
parsed.source   // in log string
// After
lastFullLyrics?.lyricsSource
parsed.lyricsSource
```

**`display.html` lines 283, 523, 629:**
```js
// Before
source: s.source
if (state.source) sourceBadge.textContent = state.source
if (c.source) sourceBadge.textContent = c.source
// After
lyricsSource: s.lyricsSource
if (state.lyricsSource) sourceBadge.textContent = state.lyricsSource
if (c.lyricsSource) sourceBadge.textContent = c.lyricsSource
```

### Status

**Fix is in the committed code.** All three files have the correct field name. The fix has not yet been verified end-to-end with a live Spotify session from the new repo location — that needs to happen next.

---

## What Needs Verification

Run through this checklist after starting the server from the repo for the first time:

1. **Start server from repo:**
   ```powershell
   cd C:\Users\ryana\Desktop\CodeTest
   node server.js
   ```
   Confirm it prints the startup banner with local + network IPs.

2. **Apply Spicetify bridge:**
   ```powershell
   spicetify apply
   ```
   Restart Spotify if prompted.

3. **Play a song in Spotify.** Check the Spotify developer console (DevTools via Spicetify) for:
   ```
   [ShowerBridge] Lyrics from lrclib-exact (N lines)
   ```

4. **Open the display in a browser** at `http://localhost:3000`. Check the browser console — you should see a `fullLyrics` message arrive with lines populated.

5. **Check `/status`:**
   ```
   http://localhost:3000/status
   ```
   `lyricsSource` should be `"lrclib-exact"` (or whichever matched), `lyricsLines` should be non-zero.

6. **Confirm lyrics scroll in sync** with playback.

7. **Open on iPad over WiFi** using the network IP printed at server start.

---

## Known Gaps / Not Yet Tested

- **Songs with no synced lyrics:** The Spotify internal API fallback returns `syncType: 'UNSYNCED'`. The display skips position-based advancement for unsynced lyrics. What the user actually sees in that case hasn't been confirmed.
- **Spotify lyrics panel closed:** Word-level sync (`wordupdate`) comes from polling Spotify's lyrics DOM. If the user closes Spotify's lyrics panel, `wordupdate` stops. The display synthesizes word spans from line text as a fallback — this fallback has not been tested.
- **iPad end-to-end:** Not confirmed from the new server location yet.

---

## Git Remote

```
https://github.com/BrunchLunch/Web-Lyrics.git
```

Branch: `main`
