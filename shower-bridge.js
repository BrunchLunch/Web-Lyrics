(function () {
  const WS_URL = 'ws://localhost:3000';

  let ws = null;
  let wordPollInterval = null;
  let currentTrackId = null;
  let playerReady = false;

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

    ws.onclose = () => setTimeout(connect, 3000);
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

  function parseLrc(lrc) {
    if (!lrc) return null;

    const lines = [];

    for (const line of lrc.split('\n')) {
      const match = line.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/);

      if (!match) continue;

      const ms =
        parseInt(match[1]) * 60000 +
        parseInt(match[2]) * 1000 +
        parseInt(match[3].padEnd(3, '0'));

      const text = match[4].trim();

      if (text) {
        lines.push({
          startTimeMs: ms,
          text
        });
      }
    }

    return lines.length ? lines : null;
  }

  // ─────────────────────────────────────────────────────────────
  // LRCLIB via Local Proxy
  // ─────────────────────────────────────────────────────────────

  async function proxyFetch(path, params) {
    const url =
      `http://localhost:3000${path}?` +
      new URLSearchParams(params).toString();

    const res = await fetch(url);

    if (!res.ok) {
      console.warn('[ShowerBridge] Proxy status:', res.status);
      return null;
    }

    return await res.json();
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
      const token      = Spicetify.Platform.Session.accessToken;
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

      const lines = (data?.lyrics?.lines || [])
        .map(l => ({
          startTimeMs: parseInt(l.startTimeMs || 0),
          text: l.words || ''
        }))
        .filter(l => l.text && l.text !== '♪');

      if (!lines.length) return null;

      return {
        lines,
        syncType: data?.lyrics?.syncType || 'UNSYNCED'
      };

    } catch (e) {
      console.warn('[ShowerBridge] Spotify API error:', e.message);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Main Lyrics Fetch
  // ─────────────────────────────────────────────────────────────

  async function fetchAndSendLyrics() {
    const trackId = getTrackId();
    const meta = getCleanMeta();

    if (!trackId || !meta) return;

    currentTrackId = trackId;

    console.log(
      '[ShowerBridge] Fetching:',
      meta.title,
      '/',
      meta.artist_name
    );

    let lines = null;
    let syncType = 'LINE_SYNCED';
    let source = '';

    // Spotify and LRCLib exact run in parallel — neither blocks the other.
    // Spotify has a 3s abort timeout so a blocked request doesn't stall everything.
    const [spotifyResult, lrclibExact] = await Promise.all([
      trySpotifyApi(trackId),
      tryLrclibExact(meta)
    ]);

    // Prefer Spotify synced lyrics (timestamps match wordupdate exactly)
    if (spotifyResult && spotifyResult.syncType !== 'UNSYNCED') {
      lines    = spotifyResult.lines;
      syncType = spotifyResult.syncType;
      source   = 'spotify';
    }

    // LRCLib exact already fetched — use it if Spotify didn't deliver synced lyrics
    if (!lines && lrclibExact) {
      lines  = lrclibExact;
      source = 'lrclib-exact';
    }

    // Sequential fallbacks only if both parallel attempts failed
    if (!lines) {
      lines = await tryLrclibSearch(meta);
      if (lines) source = 'lrclib-search';
    }

    if (!lines) {
      lines = await tryLrclibQuery(meta);
      if (lines) source = 'lrclib-query';
    }

    // Spotify unsynced as last resort
    if (!lines && spotifyResult) {
      lines    = spotifyResult.lines;
      syncType = spotifyResult.syncType;
      source   = 'spotify-unsynced';
    }

    // Send

    if (lines) {
      console.log(
        `[ShowerBridge] Lyrics from ${source} (${lines.length} lines)`
      );

      send({
        type: 'fullLyrics',
        lines,
        syncType,
        lyricsSource: source,
        positionMs: Spicetify.Player.getProgress(),
        ...getTrackInfo()
      });

    } else {
      console.warn('[ShowerBridge] No lyrics found');

      send({
        type: 'noLyrics',
        ...getTrackInfo()
      });
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

  function observeLyrics() {
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