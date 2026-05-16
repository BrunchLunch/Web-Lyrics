(function () {
  const WS_URL = 'ws://localhost:3000';

  let ws = null;
  let wordPollInterval = null;
  let positionHeartbeatInterval = null;
  let currentTrackId = null;
  let playerReady = false;
  let lyricsObserver = null;

  // ─────────────────────────────────────────────────────────────
  // WebSocket
  // ─────────────────────────────────────────────────────────────

  function connect() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('[ShowerBridge] Connected');

      if (playerReady) {
        sendTrackInfo();
        fetchAndSendLyrics();
      }
    };

    ws.onclose = () => {
      clearInterval(wordPollInterval);
      clearInterval(positionHeartbeatInterval);
      wordPollInterval = null;
      positionHeartbeatInterval = null;
      setTimeout(connect, 3000);
    };
    ws.onerror = () => ws.close();
  }

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        source: 'spicetify',
        ...data
      }));
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Metadata Helpers
  // ─────────────────────────────────────────────────────────────

  function spotifyUriToUrl(uri) {
    if (!uri) return '';

    if (uri.startsWith('https')) return uri;

    if (uri.startsWith('spotify:image:')) {
      return 'https://i.scdn.co/image/' + uri.split('spotify:image:')[1];
    }

    return '';
  }

  function cleanTrack(title = '') {
    return title
      .replace(/\(.*?remaster.*?\)/gi, '')
      .replace(/\[.*?remaster.*?\]/gi, '')
      .replace(/\(feat\..*?\)/gi, '')
      .replace(/\(ft\..*?\)/gi, '')
      .replace(/\[feat\..*?\]/gi, '')
      .replace(/\[ft\..*?\]/gi, '')
      .replace(/\- live.*$/gi, '')
      .replace(/\- remaster.*$/gi, '')
      .replace(/\- radio edit.*$/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cleanArtist(artist = '') {
    return artist
      .split(',')[0]
      .split('&')[0]
      .trim();
  }

  function getTrackInfo() {
    const meta = Spicetify.Player.data?.item?.metadata;

    const albumArt =
      spotifyUriToUrl(meta?.image_xlarge_url) ||
      spotifyUriToUrl(meta?.image_url) ||
      meta?.['canvas.url'] ||
      '';

    return {
      trackName: meta?.title || '',
      artist: meta?.artist_name || '',
      albumArt
    };
  }

  function getCleanMeta() {
    const meta = Spicetify.Player.data?.item?.metadata || {};

    return {
      ...meta,
      title: cleanTrack(meta.title || ''),
      artist_name: cleanArtist(meta.artist_name || '')
    };
  }

  function sendTrackInfo() {
    send({
      type: 'trackInfo',
      ...getTrackInfo()
    });
  }

  function getTrackId() {
    const uri = Spicetify.Player.data?.item?.uri || '';
    return uri.split(':').pop();
  }

  // ─────────────────────────────────────────────────────────────
  // LRC Parsing
  // ─────────────────────────────────────────────────────────────

  function lrcMs(mm, ss, xx) {
    return parseInt(mm) * 60000 + parseInt(ss) * 1000 + parseInt(xx.padEnd(3, '0'));
  }

  function splitWords(text) {
    const stripped = text.replace(/[♪♫♩♬]/g, '').trim();
    if (!stripped || /^[.\s]+$/.test(stripped)) return [];
    return stripped.split(/\s+/).filter(w => w.length > 0);
  }

  // Returns { lines: [{startTimeMs, text, wordTimestamps?}], hasWordTimestamps } | null
  function parseLrc(lrc) {
    if (!lrc) return null;

    const hasWordTags = /<\d{2}:\d{2}\.\d{2,3}>/.test(lrc);
    const lines = [];

    for (const raw of lrc.split('\n')) {
      const m = raw.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/);
      if (!m) continue;

      const lineMs = lrcMs(m[1], m[2], m[3]);
      const body   = m[4];

      if (hasWordTags) {
        const wMatches = [...body.matchAll(/<(\d{2}):(\d{2})\.(\d{2,3})>([^<]*)/g)];
        if (wMatches.length) {
          const wordTimestamps = wMatches
            .map(wm => ({ startMs: lrcMs(wm[1], wm[2], wm[3]), text: wm[4].trim() }))
            .filter(wt => splitWords(wt.text).length > 0);
          const text = wordTimestamps.map(wt => wt.text).join(' ');
          if (text) lines.push({ startTimeMs: lineMs, text, wordTimestamps });
        } else {
          const text = body.replace(/<[^>]+>/g, '').trim();
          if (text && text !== '♪') lines.push({ startTimeMs: lineMs, text });
        }
      } else {
        const text = body.trim();
        if (text && text !== '♪') lines.push({ startTimeMs: lineMs, text });
      }
    }

    return lines.length ? { lines, hasWordTimestamps: hasWordTags } : null;
  }

  // ─────────────────────────────────────────────────────────────
  // LRCLIB via Local Proxy
  // ─────────────────────────────────────────────────────────────

  async function proxyFetch(path, params) {
    const url =
      `http://localhost:3000${path}?` +
      new URLSearchParams(params).toString();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(url, { signal: controller.signal });

      if (!res.ok) {
        console.warn('[ShowerBridge] Proxy status:', res.status);
        return null;
      }

      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function tryLrclibExact(meta) {
    try {
      const data = await proxyFetch('/lrclib/get', {
        artist_name: meta.artist_name || '',
        track_name: meta.title || '',
        album_name: meta.album_title || '',
        duration: Math.round(parseInt(meta.duration || 0) / 1000)
      });

      return parseLrc(data?.syncedLyrics);
    } catch (e) {
      console.warn('[ShowerBridge] lrclib exact error:', e.message);
      return null;
    }
  }

  async function tryLrclibSearch(meta) {
    try {
      const data = await proxyFetch('/lrclib/search', {
        artist_name: meta.artist_name || '',
        track_name: meta.title || ''
      });

      for (const result of (data || [])) {
        const lines = parseLrc(result?.syncedLyrics);

        if (lines) return lines;
      }

      return null;
    } catch (e) {
      console.warn('[ShowerBridge] lrclib search error:', e.message);
      return null;
    }
  }

  async function tryLrclibQuery(meta) {
    try {
      const data = await proxyFetch('/lrclib/search', {
        q: `${meta.artist_name} ${meta.title}`
      });

      for (const result of (data || [])) {
        const lines = parseLrc(result?.syncedLyrics);

        if (lines) return lines;
      }

      return null;
    } catch (e) {
      console.warn('[ShowerBridge] lrclib query error:', e.message);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Spotify Internal Lyrics
  // ─────────────────────────────────────────────────────────────

  async function trySpotifyApi(trackId) {
    try {
      const token = Spicetify?.Platform?.Session?.accessToken;
      if (!token) return null;

      const controller = new AbortController();
      const timer      = setTimeout(() => controller.abort(), 3000);

      const res = await fetch(
        `https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}?format=json&vocalRemoval=false&market=from_token`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'app-platform': 'WebPlayer'
          },
          signal: controller.signal
        }
      );
      clearTimeout(timer);

      if (!res.ok) {
        console.warn('[ShowerBridge] Spotify lyrics status:', res.status);
        return null;
      }

      const data = await res.json();
      const syncType = data?.lyrics?.syncType || 'UNSYNCED';
      const rawLines = data?.lyrics?.lines || [];

      if (!rawLines.length) return null;

      return { rawLines, syncType };

    } catch (e) {
      console.warn('[ShowerBridge] Spotify API error:', e.message);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Normalizers — produce canonical {lineIndex, startMs, endMs, rawText,
  //   syncSource, words[], startTimeMs, text} regardless of source
  // ─────────────────────────────────────────────────────────────

  // Normalize raw Spotify API lines (handles WORD_SYNCED syllables + LINE_SYNCED)
  function normalizeSpotifyLines(rawLines, syncType, trackDurationMs) {
    const out = [];
    for (let i = 0; i < rawLines.length; i++) {
      const raw  = rawLines[i];
      const next = rawLines[i + 1];
      const startMs = parseInt(raw.startTimeMs || 0);
      const endMs   = next ? parseInt(next.startTimeMs || 0) : (trackDurationMs || startMs + 5000);

      let rawText, words, syncSource;

      if (raw.syllables?.length) {
        rawText    = raw.syllables.map(s => s.syllable).join(' ');
        words      = raw.syllables.map((s, si) => {
          const nextS = raw.syllables[si + 1];
          return {
            word:    s.syllable,
            startMs: parseInt(s.startTimeMs || 0),
            endMs:   nextS ? parseInt(nextS.startTimeMs || 0) : (parseInt(raw.endTimeMs) || endMs)
          };
        });
        syncSource = 'word_synced';
      } else {
        rawText = (raw.words || '').replace(/[♪♫♩♬]/g, '').trim();
        if (!splitWords(rawText).length) continue;
        syncSource = 'line_estimated';
      }

      if (!rawText) continue;
      out.push({
        lineIndex: out.length, startMs, endMs, rawText, syncSource,
        ...(words ? { words } : {}),
        startTimeMs: startMs, text: rawText
      });
    }
    return out;
  }

  // Normalize LRCLIB parsed lines (handles Enhanced LRC word timestamps + standard LRC)
  function normalizeLrclibLines(lines, trackDurationMs) {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const raw  = lines[i];
      const next = lines[i + 1];
      const startMs = raw.startTimeMs;
      const endMs   = next ? next.startTimeMs : (trackDurationMs || startMs + 5000);

      let words, syncSource;

      if (raw.wordTimestamps?.length) {
        words = raw.wordTimestamps.map((wt, wi) => {
          const nextWt = raw.wordTimestamps[wi + 1];
          return { word: wt.text, startMs: wt.startMs, endMs: nextWt ? nextWt.startMs : endMs };
        });
        syncSource = 'word_synced';
      } else {
        if (!splitWords(raw.text).length) continue;
        syncSource = 'line_estimated';
      }

      out.push({
        lineIndex: out.length, startMs, endMs, rawText: raw.text, syncSource,
        ...(words ? { words } : {}),
        startTimeMs: startMs, text: raw.text
      });
    }
    return out;
  }

  // ─────────────────────────────────────────────────────────────
  // Main Lyrics Fetch
  // ─────────────────────────────────────────────────────────────

  async function fetchAndSendLyrics() {
    const trackId = getTrackId();
    const meta    = getCleanMeta();

    if (!trackId || !meta) return;

    currentTrackId = trackId;

    console.log('[ShowerBridge] Fetching:', meta.title, '/', meta.artist_name);

    const trackDurationMs = parseInt(meta.duration || 0);
    let lines    = null;
    let syncType = 'LINE_SYNCED';
    let source   = '';

    // Spotify and LRCLib exact run in parallel.
    // Spotify has a 3s abort timeout so a blocked request doesn't stall everything.
    const [spotifyResult, lrclibExact] = await Promise.all([
      trySpotifyApi(trackId),
      tryLrclibExact(meta)
    ]);

    // Prefer Spotify synced lyrics
    if (spotifyResult && spotifyResult.syncType !== 'UNSYNCED') {
      const normalized = normalizeSpotifyLines(spotifyResult.rawLines, spotifyResult.syncType, trackDurationMs);
      if (normalized.length) {
        lines    = normalized;
        syncType = spotifyResult.syncType;
        source   = 'spotify';
      }
    }

    // LRCLib exact already fetched — use it if Spotify didn't deliver synced lyrics
    if (!lines && lrclibExact) {
      const normalized = normalizeLrclibLines(lrclibExact.lines, trackDurationMs);
      if (normalized.length) {
        lines    = normalized;
        syncType = lrclibExact.hasWordTimestamps ? 'WORD_SYNCED' : 'LINE_SYNCED';
        source   = 'lrclib-exact';
      }
    }

    // Sequential fallbacks only if both parallel attempts failed
    if (!lines) {
      const r = await tryLrclibSearch(meta);
      if (r) {
        const normalized = normalizeLrclibLines(r.lines, trackDurationMs);
        if (normalized.length) {
          lines    = normalized;
          syncType = r.hasWordTimestamps ? 'WORD_SYNCED' : 'LINE_SYNCED';
          source   = 'lrclib-search';
        }
      }
    }

    if (!lines) {
      const r = await tryLrclibQuery(meta);
      if (r) {
        const normalized = normalizeLrclibLines(r.lines, trackDurationMs);
        if (normalized.length) {
          lines    = normalized;
          syncType = r.hasWordTimestamps ? 'WORD_SYNCED' : 'LINE_SYNCED';
          source   = 'lrclib-query';
        }
      }
    }

    // Spotify unsynced as last resort
    if (!lines && spotifyResult) {
      const normalized = normalizeSpotifyLines(spotifyResult.rawLines, spotifyResult.syncType, trackDurationMs);
      if (normalized.length) {
        lines    = normalized;
        syncType = 'UNSYNCED';
        source   = 'spotify-unsynced';
      }
    }

    // If the user skipped mid-fetch, discard results for the old track
    if (currentTrackId !== trackId) return;

    if (lines?.length) {
      console.log(`[ShowerBridge] Lyrics from ${source} (${lines.length} lines)`);
      send({
        type: 'fullLyrics',
        lines,
        syncType,
        lyricsSource: source,
        positionMs: Spicetify.Player.getProgress(),
        playing: Spicetify.Player.isPlaying(),
        ...getTrackInfo()
      });
      startPositionHeartbeat();
    } else {
      console.warn('[ShowerBridge] No lyrics found');
      send({ type: 'noLyrics', ...getTrackInfo() });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Word Sync Polling
  // ─────────────────────────────────────────────────────────────

  function isWordNode(node) {
    if (!(node instanceof Element)) return false;

    return (
      (node.classList.contains('word') &&
        !node.classList.contains('PartOfWord')) ||
      node.classList.contains('word-group') ||
      node.classList.contains('letterGroup')
    );
  }

  function getWordText(node) {
    if (node.classList.contains('word-group')) {
      return Array.from(node.querySelectorAll('.word'))
        .map(w => w.textContent.trim())
        .join('');
    }

    if (node.classList.contains('letterGroup')) {
      return Array.from(node.querySelectorAll('.letter'))
        .map(l => l.textContent.trim())
        .join('');
    }

    return node.textContent.trim();
  }

  function getGradientPosition(node) {
    if (node.classList.contains('letterGroup')) {
      const first = node.querySelector('.letter');

      return first
        ? parseFloat(first.style.getPropertyValue('--gradient-position')) || -20
        : -20;
    }

    if (node.classList.contains('word-group')) {
      const first = node.querySelector('.word');

      return first
        ? parseFloat(first.style.getPropertyValue('--gradient-position')) || -20
        : -20;
    }

    return (
      parseFloat(node.style.getPropertyValue('--gradient-position')) || -20
    );
  }

  function startWordPolling(lineEl) {
    clearInterval(wordPollInterval);

    wordPollInterval = setInterval(() => {
      if (!lineEl.isConnected) {
        clearInterval(wordPollInterval);
        return;
      }

      const words = Array.from(lineEl.childNodes)
        .filter(isWordNode)
        .map(node => ({
          text: getWordText(node),
          pos: getGradientPosition(node)
        }))
        .filter(w => w.text.length > 0);

      send({
        type: 'wordupdate',
        words,
        ...getTrackInfo()
      });

    }, 50);
  }

  function startPositionHeartbeat() {
    clearInterval(positionHeartbeatInterval);
    positionHeartbeatInterval = setInterval(() => {
      send({ type: 'position', positionMs: Spicetify.Player.getProgress() });
    }, 5000);
  }

  function observeLyrics() {
    if (lyricsObserver) lyricsObserver.disconnect();
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type !== 'attributes') continue;

        const el = mutation.target;

        if (
          !el.classList?.contains('line') ||
          !el.classList?.contains('Active')
        ) {
          continue;
        }

        const hasWordSync =
          Array.from(el.childNodes).some(isWordNode);

        if (hasWordSync) {
          startWordPolling(el);
        } else {
          clearInterval(wordPollInterval);
        }

        send({
          type: 'position',
          positionMs: Spicetify.Player.getProgress()
        });
      }
    });

    lyricsObserver = observer;
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Events
  // ─────────────────────────────────────────────────────────────

  Spicetify.Player.addEventListener('songchange', () => {
    currentTrackId = null;

    clearInterval(wordPollInterval);
    clearInterval(positionHeartbeatInterval);

    setTimeout(() => {
      sendTrackInfo();
      fetchAndSendLyrics();
    }, 800);
  });

  Spicetify.Player.addEventListener('onplaypause', () => {
    send({
      type: 'playpause',
      playing: Spicetify.Player.isPlaying(),
      positionMs: Spicetify.Player.getProgress()
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Init
  // ─────────────────────────────────────────────────────────────

  function init() {
    connect();

    observeLyrics();

    const ready = setInterval(() => {
      if (Spicetify?.Player?.data?.item?.metadata?.title) {
        clearInterval(ready);

        playerReady = true;

        console.log(
          '[ShowerBridge] Ready:',
          Spicetify.Player.data.item.metadata.title
        );

        if (ws && ws.readyState === WebSocket.OPEN) {
          sendTrackInfo();
          fetchAndSendLyrics();
        }
      }
    }, 500);

    setTimeout(() => clearInterval(ready), 30000);
  }

  init();

})();

// v7