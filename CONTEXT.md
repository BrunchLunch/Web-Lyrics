# Shower Lyrics — Project Context

Node.js/Express/WebSocket server that reads the currently playing Spotify track via a Spicetify extension and displays synced lyrics on a browser page (typically a shower tablet).

---

## Architecture

```
Spotify (desktop) → Spicetify extension (shower-bridge.js)
                          ↓  WebSocket (ws://localhost:3000)
                       server.js  (Node/Express + ws)
                          ↓  WebSocket broadcast
                       display.html  (browser UI on tablet)
```

- **`shower-bridge.js`** — Spicetify extension, runs inside Spotify's browser context. Reads Spotify's internal karaoke DOM (`observeLyrics`) and fetches lyrics from Spotify's internal API and LRCLib. Sends events over WebSocket.
- **`server.js`** — Relays messages from bridge to display clients. Proxies LRCLib and album art fetches to dodge CORS. Maintains state for late-joining displays. Extrapolates playback position server-side.
- **`display.html`** — Full-screen lyrics UI. Handles three rendering modes: plain line-sync, LRCLib top-down fill animation, and Spicetify word-by-word gradient reveal.

---

## Message types (bridge → server → display)

| type | description |
|---|---|
| `fullLyrics` | New song with synced lines (`lines[]`, `syncType`, `lyricsSource`, `positionMs`) |
| `position` | Fired by `observeLyrics` on every line change — updates playback position |
| `wordupdate` | Every 50 ms while a karaoke line is active — `words[{text, pos}]` where `pos` is `--gradient-position` (0–100, negative = not started) |
| `playpause` | Play/pause state change |
| `trackInfo` | Track metadata only (album art, title, artist) |
| `noLyrics` | No lyrics found for the track |
| `line` | Legacy streaming mode, not primary path |

---

## Lyric source priority (shower-bridge.js)

Runs Spotify API and LRCLib exact **in parallel** (Promise.all). Spotify has a 3 s AbortController timeout because it can hang.

1. **Spotify internal API** — `LINE_SYNCED` or `WORD_SYNCED` only. Timestamps match Spicetify's karaoke DOM exactly, so `wordupdate` line detection is always consistent.
2. **LRCLib exact** — fetched in parallel with Spotify; used if Spotify has no synced lyrics.
3. **LRCLib search** — sequential fallback.
4. **LRCLib query** — sequential fallback.
5. **Spotify unsynced** — last resort; `syncType = UNSYNCED`.

**Critical:** Do not revert to LRCLib-first. LRCLib timestamps diverge from Spotify's internal karaoke timestamps, causing the wrong line to be highlighted on word-sync songs. Spotify-first guarantees both use the same clock.

---

## Display rendering (display.html)

### State variables
| var | meaning |
|---|---|
| `wordModeOn` | User toggle (default OFF). Controls whether word spans are rendered. |
| `hasRealWordSync` | True once first `wordupdate` for the current song arrives. |
| `activeIdx` | Index into `allLines[]` of the currently highlighted line. |
| `wordStates[]` | Per-word state for the active line (`text`, `startPos`, `startTime`, `duration`, `revealed`). |
| `activeWordIdx` | Index of the word currently being animated (-1 = none). |

### Three rendering modes in `applyActiveLineMode(div)`
1. **`wordModeOn && hasRealWordSync && wordStates.length > 0`** — Creates `.word-span` elements; RAF-driven gradient reveal per word.
2. **`wordModeOn && !hasRealWordSync`** — Top-to-bottom brightness fill animation via `animateLineHighlight` RAF (LRCLib style).
3. **Plain** — No gradient, just opacity via distance classes.

### `advanceByPosition()`
- Runs every 50 ms and on every `position` message.
- **Yields entirely** when `hasRealWordSync && wordStates.length > 0` — lets Spicetify's `wordupdate` own `activeIdx` for word-sync songs.
- Has 800 ms hysteresis on backward jumps to avoid oscillation from position extrapolation.

### `renderLines()` — in-place DOM updates
- Only does a full DOM rebuild when line count changes (new song). Otherwise updates `className` on existing divs so CSS `opacity` transitions fire.
- **Never call `innerHTML = ''` on the whole container for a line advance** — that destroys element state and CSS transitions won't fire.

### `findLineByWords(words)`
- Text-matches `wordupdate.words` against `allLines` by normalizing and joining word text.
- Searches outward from `activeIdx` so nearby lines are found fast.
- Returns -1 if no match. When it returns -1, `lineChanged = false` and `activeIdx` is not updated.

---

## Key bugs fixed (don't re-introduce)

### 1. Lines teleporting / opacity transitions not firing
**Cause:** `renderLines()` called `lyricsEl.innerHTML = ''` on every line change, destroying all divs. CSS `transition: opacity` never fired because elements had no prior opacity state.  
**Fix:** In-place `className` updates on persistent divs. Full rebuild only when div count ≠ line count.

### 2. Early line skipping + oscillation
**Cause:** `currentPositionMs()` extrapolation jumps ahead of server-confirmed position; a position update snaps it back; extrapolation jumps again.  
**Fix:** `advanceByPosition` ignores backward jumps smaller than 800 ms.

### 3. Wrong line highlighted on word-sync songs (lyric source order)
**Cause:** LRCLib was the primary lyric source. Its timestamps differ from Spotify's internal karaoke timestamps (which drive `observeLyrics` DOM events). `fullLyrics` and `wordupdate` line-change events were on different clocks.  
**Fix:** Spotify API is now first. Its timestamps are identical to what `observeLyrics` fires on.

### 4. Synthesized words corrupting real word state
**Cause:** `synthesizeWordStates` was called when `hasRealWordSync = true`, creating fake word spans from LRCLib text that could overwrite real Spicetify word states.  
**Fix:** Removed `synthesizeWordStates` entirely. `advanceByPosition` just clears `wordStates = []`.

### 5. Same-word-count consecutive lines not detected
**Cause:** New-line detection compared `wordStates.length !== state.words.length`.  
**Fix:** Compare joined word text strings: `words.map(w=>w.text).join(' ')`.

### 6. `advanceByPosition` fighting Spicetify on word-sync songs
**Cause:** 50 ms LRCLib timestamp poll kept resetting `activeIdx` even when Spicetify had already set the correct line via `wordupdate`.  
**Fix:** `advanceByPosition` early-returns when `hasRealWordSync && wordStates.length > 0`.

### 7. Spotify API blocking / hanging
**Cause:** Spotify's lyrics endpoint can stall (network block or Spicetify intercept). Placing it first sequentially blocked everything.  
**Fix:** (a) 3 s `AbortController` timeout on Spotify fetch. (b) Run Spotify and LRCLib exact in parallel via `Promise.all` so LRCLib resolves during any Spotify wait.

### 8. Display frozen on word-sync songs with word mode OFF (v4.4)
**Cause:** After `wordStates` is first populated, `advanceByPosition` yields. Line advances then depend entirely on `wordupdate` calling `renderLines()`. But the handler only called `renderLines()` when `wordModeOn = true`. Default is OFF. So `activeIdx` was updated in state but the DOM was never refreshed — display frozen on first active line.  
**Fix:** `if (wordModeOn || lineChanged) renderLines()` — always render when the active line actually changes, regardless of word mode.

---

## Files and install locations

| file | purpose |
|---|---|
| `server.js` | Node server — `node server.js` |
| `display.html` | Browser UI, served at `http://localhost:3000/` |
| `shower-bridge.js` (project) | Source copy |
| `%APPDATA%\spicetify\Extensions\shower-bridge.js` | Installed copy — keep in sync manually |

After editing `shower-bridge.js`, copy to extensions folder and run `spicetify apply` (or reload from Spicetify dev menu).

---

## Version history

| version | change |
|---|---|
| bridge v7 | Spotify API + LRCLib parallel fetch; 3 s abort timeout |
| display v4.1 | In-place DOM updates (no more innerHTML wipe per advance) |
| display v4.2 | Hysteresis on backward jumps; bigger active line font |
| display v4.3 | findLineByWords text matching; synthesizeWordStates removed; advanceByPosition yields to Spicetify |
| display v4.4 | Fixed frozen display with word mode OFF — renderLines called on lineChanged regardless of wordModeOn |
