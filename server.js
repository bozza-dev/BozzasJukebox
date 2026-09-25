// Jukebox: guests search and request songs; the host's Spotify account plays them.
// Zero dependencies — needs Node 20.6+ (built-in fetch and --env-file).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8888;
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || `http://127.0.0.1:${PORT}/callback`;
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const DATA_FILE = path.join(__dirname, '.jukebox-data.json');
const MESSAGE_MAX = 140;
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET. Copy .env.example to .env and fill them in.');
  process.exit(1);
}

// ---------- persisted state (admin key, Spotify refresh token, settings) ----------

const DEFAULT_SETTINGS = {
  autoApprove: false,     // queue requests straight to Spotify without host approval
  allowExplicit: true,
  paused: false,          // stop accepting new requests
  maxPendingPerGuest: 3,  // how many unapproved requests one guest can have at once
  cooldownSec: 60,        // minimum gap between requests from one guest
};

const store = (() => {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
})();
store.adminKey ||= crypto.randomBytes(12).toString('hex');
store.settings = { ...DEFAULT_SETTINGS, ...store.settings };
saveStore();

function saveStore() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

// ---------- in-memory state (lives for the length of the party) ----------

const requests = [];                 // { id, track, guestId, guestName, message, status, createdAt, decidedAt, error }
const lastRequestAt = new Map();     // guestId -> timestamp
const searchHits = new Map();        // guestId -> [timestamps] for search rate limiting
const trackCache = new Map();        // trackId -> track, filled from search results
const oauthStates = new Set();

// ---------- Spotify ----------

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

let access = { token: null, expiresAt: 0 };
let refreshing = null;

async function tokenRequest(params) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
    },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.error === 'invalid_grant' && params.grant_type === 'refresh_token') {
      delete store.refreshToken; // revoked or expired — host must reconnect
      saveStore();
    }
    throw new ApiError(502, 'AUTH_FAILED', data.error_description || data.error || `Spotify token request failed (${res.status})`);
  }
  access = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  if (data.refresh_token) { store.refreshToken = data.refresh_token; saveStore(); }
}

async function getAccessToken() {
  if (access.token && Date.now() < access.expiresAt - 60_000) return access.token;
  if (!store.refreshToken) throw new ApiError(503, 'NOT_CONNECTED', "The host hasn't connected Spotify yet.");
  refreshing ||= tokenRequest({ grant_type: 'refresh_token', refresh_token: store.refreshToken })
    .finally(() => { refreshing = null; });
  await refreshing;
  return access.token;
}

async function spotify(method, endpoint, query, retry = true) {
  const token = await getAccessToken();
  const url = new URL('https://api.spotify.com/v1' + endpoint);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 && retry) {
    access.token = null;
    return spotify(method, endpoint, query, false);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* some endpoints return non-JSON bodies */ }
  if (!res.ok) {
    const reason = data?.error?.reason;
    const message = data?.error?.message || `Spotify returned ${res.status}`;
    if (reason === 'NO_ACTIVE_DEVICE' || (res.status === 404 && /device/i.test(message))) {
      throw new ApiError(409, 'NO_ACTIVE_DEVICE', "Spotify isn't playing on any device. Start playback on the host's Spotify, then try again.");
    }
    if (reason === 'PREMIUM_REQUIRED') {
      throw new ApiError(403, 'PREMIUM_REQUIRED', 'Adding to the queue needs Spotify Premium on the host account.');
    }
    if (res.status === 429) throw new ApiError(429, 'RATE_LIMITED', 'Spotify is busy — try again in a few seconds.');
    throw new ApiError(502, 'SPOTIFY_ERROR', message);
  }
  return data;
}

function toItem(t) {
  if (!t) return null;
  const images = t.album?.images || t.images || t.show?.images || [];
  return {
    id: t.id,
    uri: t.uri,
    name: t.name,
    artists: t.artists ? t.artists.map(a => a.name).join(', ') : (t.show?.name || ''),
    album: t.album?.name || '',
    art: (images[1] || images[0])?.url || '',
    thumb: images.at(-1)?.url || '',
    explicit: !!t.explicit,
    durationMs: t.duration_ms || 0,
  };
}

function cacheTrack(track) {
  trackCache.delete(track.id);
  trackCache.set(track.id, track);
  if (trackCache.size > 2000) trackCache.delete(trackCache.keys().next().value);
}

// Now-playing + upcoming queue, cached so a room full of phones polling doesn't hammer Spotify.
let player = { at: 0, data: null, pending: null };

async function getPlayer() {
  if (Date.now() - player.at < 4000) return player.data;
  player.pending ||= (async () => {
    let data;
    try {
      const [current, queue] = await Promise.all([
        spotify('GET', '/me/player/currently-playing'),
        spotify('GET', '/me/player/queue').catch(() => null),
      ]);
      data = {
        isPlaying: !!current?.is_playing,
        progressMs: current?.progress_ms || 0,
        nowPlaying: toItem(current?.item),
        upNext: (queue?.queue || []).slice(0, 20).map(toItem),
      };
    } catch (err) {
      data = { isPlaying: false, nowPlaying: null, upNext: [], error: err.code };
    }
    player = { at: Date.now(), data, pending: null };
    if (data.nowPlaying) retryStalled();
  })();
  await player.pending;
  return player.data;
}

function invalidatePlayer() { player.at = 0; }

// With auto-approve on, a request that arrived while nothing was playing is left pending
// with an error. Once Spotify has an active device again, queue those in request order.
let retrying = false;
async function retryStalled() {
  if (retrying || !store.settings.autoApprove) return;
  retrying = true;
  try {
    for (const r of requests.filter(x => x.status === 'pending' && x.error)) {
      try { await queueRequest(r); } catch (err) { r.error = err.message; break; }
    }
  } finally {
    retrying = false;
  }
}

async function queueRequest(r) {
  await spotify('POST', '/me/player/queue', { uri: r.track.uri });
  r.status = 'queued';
  r.decidedAt = Date.now();
  r.error = null;
  invalidatePlayer();
}

// ---------- genre browsing ----------
// Spotify's genre: search filter is unreliable (hip-hop comes back as obscure tracks),
// so each genre is a curated artist list. A page is the top search hits for a few of them.
// Decades add a year filter so "80s" gets Madonna's 80s songs, not her later ones.

const GENRES = [
  { key: 'pop', label: 'Pop', artists: ['Taylor Swift', 'Dua Lipa', 'The Weeknd', 'Sabrina Carpenter', 'Bruno Mars', 'Ariana Grande', 'Lady Gaga', 'Harry Styles', 'Olivia Rodrigo', 'Chappell Roan', 'Ed Sheeran', 'Justin Bieber'] },
  { key: 'hiphop', label: 'Hip-Hop', artists: ['Drake', 'Kendrick Lamar', 'Travis Scott', 'Eminem', 'Outkast', 'Kanye West', 'J. Cole', 'Doja Cat', 'Lil Wayne', 'Missy Elliott', '50 Cent', 'Nicki Minaj'] },
  { key: 'rnb', label: 'R&B', artists: ['SZA', 'Beyoncé', 'Usher', 'Rihanna', 'Frank Ocean', 'Alicia Keys', 'Chris Brown', "Destiny's Child", 'Mariah Carey', 'Ne-Yo', 'Brent Faiyaz', 'Summer Walker'] },
  { key: 'dance', label: 'Dance', artists: ['Calvin Harris', 'David Guetta', 'Fred again..', 'Avicii', 'Daft Punk', 'Disclosure', 'Swedish House Mafia', 'Kygo', 'The Chainsmokers', 'Martin Garrix', 'Fisher', 'Peggy Gou'] },
  { key: 'rock', label: 'Rock', artists: ['Foo Fighters', 'Queen', 'AC/DC', 'Red Hot Chili Peppers', 'The Killers', 'Nirvana', "Guns N' Roses", 'Fleetwood Mac', 'Green Day', 'Linkin Park', 'Kings of Leon', 'Arctic Monkeys'] },
  { key: 'indie', label: 'Indie', artists: ['Tame Impala', 'MGMT', 'The Strokes', 'Florence + The Machine', 'Vampire Weekend', 'Glass Animals', 'Phoenix', 'Two Door Cinema Club', 'Hozier', 'The 1975', 'Mac DeMarco', 'Foster The People'] },
  { key: 'country', label: 'Country', artists: ['Morgan Wallen', 'Luke Combs', 'Zach Bryan', 'Shania Twain', 'Dolly Parton', 'Chris Stapleton', 'Kacey Musgraves', 'Johnny Cash', 'Carrie Underwood', 'Lainey Wilson', 'Garth Brooks', 'Luke Bryan'] },
  { key: 'latin', label: 'Latin', artists: ['Bad Bunny', 'Karol G', 'J Balvin', 'Daddy Yankee', 'Shakira', 'Rosalía', 'Peso Pluma', 'Feid', 'Rauw Alejandro', 'Ozuna', 'Pitbull', 'Marc Anthony'] },
  { key: 'afrobeats', label: 'Afrobeats', artists: ['Burna Boy', 'Wizkid', 'Rema', 'Tems', 'Davido', 'Tyla', 'Ayra Starr', 'CKay', 'Asake', 'Fireboy DML'] },
  { key: 'kpop', label: 'K-Pop', artists: ['BTS', 'BLACKPINK', 'NewJeans', 'Stray Kids', 'TWICE', 'Jung Kook', 'ROSÉ', 'aespa', 'SEVENTEEN', 'LE SSERAFIM'] },
  { key: 'disco', label: 'Disco & Funk', artists: ['Bee Gees', 'ABBA', 'Earth, Wind & Fire', 'Chic', 'Donna Summer', 'Kool & The Gang', 'Gloria Gaynor', 'Stevie Wonder', 'Jamiroquai', 'Sister Sledge', 'Lipps Inc.', 'KC & The Sunshine Band'] },
  { key: '70s', label: '70s', year: '1970-1979', artists: ['Fleetwood Mac', 'Queen', 'Elton John', 'Bee Gees', 'ABBA', 'Stevie Wonder', 'Michael Jackson', 'David Bowie', 'Eagles', 'The Jackson 5', 'Earth, Wind & Fire', 'Led Zeppelin'] },
  { key: '80s', label: '80s', year: '1980-1989', artists: ['Michael Jackson', 'Madonna', 'Whitney Houston', 'Prince', 'a-ha', 'Cyndi Lauper', 'Bon Jovi', 'Tears For Fears', 'Wham!', 'Journey', 'Toto', 'Duran Duran'] },
  { key: '90s', label: '90s', year: '1990-1999', artists: ['TLC', 'Backstreet Boys', 'Spice Girls', 'Oasis', 'Britney Spears', 'No Doubt', 'Alanis Morissette', 'Coolio', 'Ace of Base', 'Nirvana', 'Mariah Carey', 'Blur'] },
  { key: '00s', label: '2000s', year: '2000-2009', artists: ['Beyoncé', 'Usher', 'The Black Eyed Peas', 'Nelly Furtado', 'The Killers', 'Outkast', 'Kelly Clarkson', 'Rihanna', 'Justin Timberlake', 'Avril Lavigne', 'Gwen Stefani', 'Kanye West'] },
  { key: '10s', label: '2010s', year: '2010-2019', artists: ['Rihanna', 'Bruno Mars', 'Drake', 'Katy Perry', 'Adele', 'Ed Sheeran', 'Calvin Harris', 'Taylor Swift', 'The Weeknd', 'Pharrell Williams', 'Mark Ronson', 'Lady Gaga'] },
];
const ARTISTS_PER_PAGE = 4;
const TRACKS_PER_ARTIST = 3;
const browseCache = new Map(); // query -> { at, tracks }; shared by every guest

async function cachedTrackSearch(q) {
  const hit = browseCache.get(q);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.tracks;
  const data = await spotify('GET', '/search', { q, type: 'track', limit: '10' });
  const tracks = (data?.tracks?.items || []).filter(Boolean).map(toItem);
  browseCache.set(q, { at: Date.now(), tracks });
  return tracks;
}

async function browseGenre(genre, page) {
  const artists = genre.artists.slice(page * ARTISTS_PER_PAGE, (page + 1) * ARTISTS_PER_PAGE);
  const perArtist = await Promise.all(artists.map(a =>
    cachedTrackSearch(`artist:"${a}"` + (genre.year ? ` year:${genre.year}` : '')).catch(err => {
      if (err.code === 'NOT_CONNECTED') throw err;
      return [];
    })));
  // Take each artist's top few (skipping re-releases of the same song), then interleave for variety.
  const seen = new Set();
  const picks = perArtist.map(tracks => tracks.filter(t => {
    const key = t.name.toLowerCase().replace(/\s*[-(\[].*$/, '') + '|' + t.artists.split(',')[0].toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, TRACKS_PER_ARTIST));
  const tracks = [];
  for (let i = 0; i < TRACKS_PER_ARTIST; i++) for (const list of picks) if (list[i]) tracks.push(list[i]);
  return { tracks, hasMore: (page + 1) * ARTISTS_PER_PAGE < genre.artists.length };
}

function checkSearchRate(guestId, admin) {
  if (admin) return;
  const now = Date.now();
  const hits = (searchHits.get(guestId) || []).filter(t => now - t < 60_000);
  if (hits.length >= 40) throw new ApiError(429, 'RATE_LIMITED', 'Slow down a little — too many searches.');
  hits.push(now);
  searchHits.set(guestId, hits);
}

function forGuests(tracks) {
  tracks.forEach(cacheTrack);
  return tracks.map(t => ({ ...t, blocked: t.explicit && !store.settings.allowExplicit }));
}

// ---------- HTTP helpers ----------

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed cookie */ }
    }
  }
  return out;
}

function isAdmin(cookies) {
  const given = Buffer.from(cookies.jb_admin || '');
  const expected = Buffer.from(store.adminKey);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function json(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });
}

function redirect(res, location, headers = {}) {
  send(res, 302, '', { Location: location, ...headers });
}

async function readJson(req) {
  if (!(req.headers['content-type'] || '').includes('application/json')) {
    throw new ApiError(415, 'BAD_REQUEST', 'Expected JSON');
  }
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) throw new ApiError(413, 'BAD_REQUEST', 'Request too large');
  }
  try { return JSON.parse(body || '{}'); } catch { throw new ApiError(400, 'BAD_REQUEST', 'Invalid JSON'); }
}

const STATIC = {
  '/app.css': ['app.css', 'text/css'],
  '/guest.js': ['guest.js', 'text/javascript'],
  '/host.js': ['host.js', 'text/javascript'],
  '/logo.svg': ['logo.svg', 'image/svg+xml'],
};

function serveFile(res, file, type) {
  fs.readFile(path.join(__dirname, 'public', file), (err, data) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, data, { 'Content-Type': `${type}; charset=utf-8` });
  });
}

function lanUrls() {
  if (PUBLIC_URL) return [PUBLIC_URL];
  const urls = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${PORT}`);
    }
  }
  return urls.length ? urls : [`http://127.0.0.1:${PORT}`];
}

function publicRequest(r) {
  return { id: r.id, track: r.track, guestName: r.guestName, message: r.message, status: r.status, createdAt: r.createdAt };
}

// ---------- routes ----------

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const cookies = parseCookies(req);
  const admin = isAdmin(cookies);

  let guestId = cookies.jb_guest;
  if (!guestId || !/^[a-f0-9]{24}$/.test(guestId)) {
    guestId = crypto.randomBytes(12).toString('hex');
    res.setHeader('Set-Cookie', `jb_guest=${guestId}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
  }

  const route = `${req.method} ${url.pathname}`;

  // ----- pages -----
  if (route === 'GET /') return serveFile(res, 'index.html', 'text/html');
  if (req.method === 'GET' && STATIC[url.pathname]) return serveFile(res, ...STATIC[url.pathname]);

  if (route === 'GET /host') {
    const key = url.searchParams.get('key');
    if (key) {
      if (key !== store.adminKey) return send(res, 403, 'Wrong host key.');
      return redirect(res, '/host', {
        'Set-Cookie': `jb_admin=${key}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`,
      });
    }
    if (!admin) return send(res, 403, 'Host page — open the link printed in the terminal where the jukebox is running.');
    return serveFile(res, 'host.html', 'text/html');
  }

  // ----- Spotify login (host only) -----
  if (route === 'GET /login') {
    if (!admin) return send(res, 403, 'Host only.');
    const state = crypto.randomBytes(12).toString('hex');
    oauthStates.add(state);
    const auth = new URL('https://accounts.spotify.com/authorize');
    auth.search = new URLSearchParams({
      response_type: 'code', client_id: CLIENT_ID, scope: SCOPES, redirect_uri: REDIRECT_URI, state,
    });
    return redirect(res, auth.toString());
  }

  if (route === 'GET /callback') {
    const state = url.searchParams.get('state');
    if (!state || !oauthStates.delete(state)) return send(res, 400, 'Login expired — go back to the host page and try again.');
    if (url.searchParams.get('error')) return redirect(res, '/host?error=' + encodeURIComponent(url.searchParams.get('error')));
    await tokenRequest({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: REDIRECT_URI });
    invalidatePlayer();
    return redirect(res, '/host');
  }

  // ----- guest API -----
  if (route === 'GET /api/search') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
    if (!q) return json(res, 200, { tracks: [] });
    checkSearchRate(guestId, admin);
    const data = await spotify('GET', '/search', { q, type: 'track', limit: '10' });
    return json(res, 200, { tracks: forGuests((data?.tracks?.items || []).filter(Boolean).map(toItem)) });
  }

  if (route === 'GET /api/genres') {
    return json(res, 200, { genres: GENRES.map(g => ({ key: g.key, label: g.label })) });
  }

  if (route === 'GET /api/browse') {
    const genre = GENRES.find(g => g.key === url.searchParams.get('genre'));
    if (!genre) throw new ApiError(404, 'NOT_FOUND', 'Unknown genre.');
    const page = Math.max(0, parseInt(url.searchParams.get('page'), 10) || 0);
    checkSearchRate(guestId, admin);
    const { tracks, hasMore } = await browseGenre(genre, page);
    return json(res, 200, { tracks: forGuests(tracks), hasMore });
  }

  if (route === 'POST /api/request') {
    const body = await readJson(req);
    const s = store.settings;
    const now = Date.now();
    if (!store.refreshToken) throw new ApiError(503, 'NOT_CONNECTED', "The host hasn't connected Spotify yet.");
    if (s.paused && !admin) throw new ApiError(403, 'PAUSED', 'Requests are paused right now.');

    const track = trackCache.get(String(body.trackId || ''));
    if (!track) throw new ApiError(404, 'UNKNOWN_TRACK', 'Search for the song again, then request it.');
    if (track.explicit && !s.allowExplicit) throw new ApiError(403, 'EXPLICIT', 'Explicit songs are turned off tonight.');

    const dupe = requests.find(r => r.track.id === track.id &&
      (r.status === 'pending' || (r.status === 'queued' && now - r.decidedAt < 60 * 60_000)));
    if (dupe) throw new ApiError(409, 'DUPLICATE', 'Someone already requested that one!');

    if (!admin) {
      const pending = requests.filter(r => r.guestId === guestId && r.status === 'pending').length;
      if (pending >= s.maxPendingPerGuest) {
        throw new ApiError(429, 'TOO_MANY', `You have ${pending} songs waiting — hang on until the host gets to them.`);
      }
      const wait = ((lastRequestAt.get(guestId) || 0) + s.cooldownSec * 1000 - now) / 1000;
      if (wait > 0) throw new ApiError(429, 'COOLDOWN', `You can request again in ${Math.ceil(wait)}s.`);
    }

    const r = {
      id: crypto.randomBytes(6).toString('hex'),
      track,
      guestId,
      guestName: String(body.guestName || '').trim().slice(0, 30) || 'Someone',
      message: String(body.message || '').replace(/\s+/g, ' ').trim().slice(0, MESSAGE_MAX),
      status: 'pending',
      createdAt: now,
      decidedAt: null,
      error: null,
    };
    requests.push(r);
    if (requests.length > 500) requests.splice(0, requests.length - 500);
    lastRequestAt.set(guestId, now);

    if (s.autoApprove) {
      // If Spotify rejects it (e.g. nothing playing), leave it pending; retryStalled() or the host picks it up.
      try { await queueRequest(r); } catch (err) { r.error = err.message; lastRequestAt.delete(guestId); }
    }
    return json(res, 200, { request: publicRequest(r), queueError: r.error ? r.error : undefined });
  }

  if (route === 'GET /api/state') {
    const connected = !!store.refreshToken;
    const s = store.settings;
    return json(res, 200, {
      connected,
      player: connected ? await getPlayer() : null,
      settings: { autoApprove: s.autoApprove, allowExplicit: s.allowExplicit, paused: s.paused },
      requests: requests.filter(r => r.status === 'pending' || r.status === 'queued').slice(-30).reverse().map(publicRequest),
      mine: requests.filter(r => r.guestId === guestId).slice(-10).reverse().map(publicRequest),
    });
  }

  // ----- host API -----
  if (url.pathname.startsWith('/api/host/')) {
    if (!admin) throw new ApiError(403, 'FORBIDDEN', 'Host only.');

    if (route === 'GET /api/host/state') {
      const connected = !!store.refreshToken;
      return json(res, 200, {
        connected,
        guestUrls: lanUrls(),
        settings: store.settings,
        player: connected ? await getPlayer() : null,
        requests: requests.slice(-100).reverse().map(r => ({ ...publicRequest(r), error: r.error })),
      });
    }

    const body = req.method === 'POST' ? await readJson(req) : {};
    const findPending = () => {
      const r = requests.find(x => x.id === body.id);
      if (!r) throw new ApiError(404, 'NOT_FOUND', 'Request not found.');
      if (r.status !== 'pending') throw new ApiError(409, 'NOT_PENDING', 'That request was already handled.');
      return r;
    };

    if (route === 'POST /api/host/approve') {
      const r = findPending();
      try { await queueRequest(r); } catch (err) { r.error = err.message; throw err; }
      return json(res, 200, { ok: true });
    }

    if (route === 'POST /api/host/reject') {
      const r = findPending();
      r.status = 'rejected';
      r.decidedAt = Date.now();
      return json(res, 200, { ok: true });
    }

    if (route === 'POST /api/host/clear-message') {
      const r = requests.find(x => x.id === body.id);
      if (!r) throw new ApiError(404, 'NOT_FOUND', 'Request not found.');
      r.message = '';
      return json(res, 200, { ok: true });
    }

    if (route === 'POST /api/host/approve-all') {
      let queued = 0;
      for (const r of requests.filter(x => x.status === 'pending')) {
        try { await queueRequest(r); queued++; } catch (err) { r.error = err.message; if (err.code === 'NO_ACTIVE_DEVICE') throw err; }
      }
      return json(res, 200, { ok: true, queued });
    }

    if (route === 'POST /api/host/settings') {
      const s = store.settings;
      for (const k of ['autoApprove', 'allowExplicit', 'paused']) {
        if (typeof body[k] === 'boolean') s[k] = body[k];
      }
      if (Number.isInteger(body.maxPendingPerGuest)) s.maxPendingPerGuest = Math.min(Math.max(body.maxPendingPerGuest, 1), 50);
      if (Number.isInteger(body.cooldownSec)) s.cooldownSec = Math.min(Math.max(body.cooldownSec, 0), 3600);
      saveStore();
      return json(res, 200, { settings: s });
    }

    if (route === 'POST /api/host/skip') {
      await spotify('POST', '/me/player/next');
      invalidatePlayer();
      return json(res, 200, { ok: true });
    }

    if (route === 'POST /api/host/disconnect') {
      delete store.refreshToken;
      saveStore();
      access = { token: null, expiresAt: 0 };
      invalidatePlayer();
      return json(res, 200, { ok: true });
    }
  }

  send(res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    const status = err instanceof ApiError ? err.status : 500;
    if (status === 500) console.error(err);
    if (res.headersSent) return res.end();
    json(res, status, { error: err.code || 'SERVER_ERROR', message: status === 500 ? 'Something went wrong.' : err.message });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n🎵  Jukebox is running\n');
  console.log(`   Host page (open on THIS computer):  http://127.0.0.1:${PORT}/host?key=${store.adminKey}`);
  console.log('   Guests join at:                     ' + lanUrls().join('  or  '));
  console.log('\n   Keep the host link private — anyone with it can approve songs and change settings.\n');
});
