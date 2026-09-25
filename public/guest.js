const $ = id => document.getElementById(id);

// ---------- helpers ----------

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) if (c != null) node.append(c);
  return node;
}

function trackRow(track, right, extra, { mine = false, tag = 'li' } = {}) {
  const title = el('div', { className: 'title', textContent: track.name });
  if (track.explicit) title.append(el('span', { className: 'tag', textContent: 'E' }));
  if (mine) title.append(el('span', { className: 'tag you', textContent: 'YOU' }));
  return el(tag, { className: 'row' + (mine ? ' mine' : '') }, [
    el('img', { src: track.thumb || '', alt: '', loading: 'lazy' }),
    el('div', { className: 'meta' }, [title, el('div', { className: 'sub', textContent: track.artists }), ...[].concat(extra)]),
    right,
  ]);
}

const status = (cls, text) => el('span', { className: 'status ' + cls, textContent: text });
// "asked for by Sam" plus their message, if they left one
const byLine = r => [
  el('div', { className: 'by', textContent: `asked for by ${r.guestName}` }),
  r.message ? el('div', { className: 'msg', textContent: r.message }) : null,
];

let toastTimer;
function toast(message, isError = false) {
  const t = $('toast');
  t.textContent = message;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast' + (isError ? ' error' : ''); }, 3500);
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'Something went wrong.');
  return data;
}

function remember(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key) || '';
    localStorage.setItem(key, value);
  } catch { return ''; } // private mode
}

// ---------- tabs ----------

function showTab(name) {
  for (const btn of document.querySelectorAll('.tabs button')) {
    const on = btn.dataset.tab === name;
    btn.setAttribute('aria-selected', on);
    $('tab-' + btn.dataset.tab).hidden = !on;
  }
  remember('jb_tab', name);
}

for (const btn of document.querySelectorAll('.tabs button')) {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
}
showTab(remember('jb_tab') === 'queue' ? 'queue' : 'find');

// ---------- name ----------

$('name').value = remember('jb_name');
$('nameShown').textContent = remember('jb_name') || 'Someone';
$('name').addEventListener('input', () => {
  const v = $('name').value.trim();
  $('nameShown').textContent = v || 'Someone';
  remember('jb_name', v);
});

// ---------- results (shared by search and genre browsing) ----------

let resultsSeq = 0;      // ignore responses that arrive after a newer search/browse started
let browsing = null;     // { key, label, page } while a genre is showing

let openComposer = null; // only one message box open at a time

function resultRow(t) {
  const btn = el('button', { textContent: t.blocked ? 'Explicit' : 'Request', disabled: t.blocked });
  const row = trackRow(t, btn);
  btn.addEventListener('click', () => toggleComposer(row, t, btn));
  return row;
}

// Tapping Request opens a message box under the song; Send (or Enter) submits.
function toggleComposer(row, track, btn) {
  if (openComposer?.row === row) return closeComposer();
  closeComposer();
  const input = el('input', {
    type: 'text', maxLength: 140, enterKeyHint: 'send',
    placeholder: 'Add a message (optional) — e.g. “for Sam’s birthday!”',
  });
  const send = el('button', { textContent: 'Send' });
  const box = el('div', { className: 'compose' }, [input, send]);
  const submit = () => requestTrack(track, btn, input.value, send);
  send.addEventListener('click', submit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') closeComposer();
  });
  row.append(box);
  btn.textContent = 'Cancel';
  btn.classList.add('ghost');
  openComposer = { row, box, btn };
  input.focus();
}

function closeComposer() {
  if (!openComposer) return;
  const { box, btn } = openComposer;
  box.remove();
  if (btn.textContent === 'Cancel') btn.textContent = 'Request';
  btn.classList.remove('ghost');
  openComposer = null;
}

function showResults(title, tracks, { append = false, hasMore = false } = {}) {
  $('resultsTitle').textContent = title;
  $('resultsTitle').hidden = !title;
  const rows = tracks.map(resultRow);
  if (append) $('results').append(...rows);
  else if (rows.length) $('results').replaceChildren(...rows);
  else $('results').replaceChildren(el('li', { className: 'empty', textContent: 'No matches — try different words.' }));
  $('moreBtn').hidden = !hasMore;
}

function clearResults() {
  resultsSeq++;
  $('results').replaceChildren();
  $('resultsTitle').hidden = true;
  $('moreBtn').hidden = true;
}

// ---------- search ----------

let searchTimer;

$('q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 350);
});
$('q').addEventListener('keydown', e => {
  if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(); $('q').blur(); }
});

async function runSearch() {
  const q = $('q').value.trim();
  if (!q) { if (!browsing) clearResults(); return; }
  setActiveGenre(null);
  const seq = ++resultsSeq;
  try {
    const { tracks } = await api('/api/search?q=' + encodeURIComponent(q));
    if (seq === resultsSeq) showResults('', tracks);
  } catch (err) {
    if (seq === resultsSeq) toast(err.message, true);
  }
}

// ---------- genres ----------

function setActiveGenre(genre) {
  browsing = genre ? { ...genre, page: 0 } : null;
  for (const chip of $('genres').children) chip.setAttribute('aria-pressed', chip.dataset.key === genre?.key);
}

async function loadGenre(append) {
  const g = browsing;
  const seq = ++resultsSeq;
  $('moreBtn').disabled = true;
  try {
    const { tracks, hasMore } = await api(`/api/browse?genre=${encodeURIComponent(g.key)}&page=${g.page}`);
    if (seq === resultsSeq) showResults(g.label, tracks, { append, hasMore });
  } catch (err) {
    if (seq === resultsSeq) toast(err.message, true);
  } finally {
    $('moreBtn').disabled = false;
  }
}

$('moreBtn').addEventListener('click', () => {
  if (!browsing) return;
  browsing.page++;
  loadGenre(true);
});

api('/api/genres').then(({ genres }) => {
  $('genres').replaceChildren(...genres.map(g => {
    const chip = el('button', { className: 'chip', textContent: g.label });
    chip.dataset.key = g.key;
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', () => {
      if (browsing?.key === g.key) { setActiveGenre(null); clearResults(); return; } // tap again to close
      $('q').value = '';
      setActiveGenre(g);
      $('results').replaceChildren();
      loadGenre(false);
    });
    return chip;
  }));
}).catch(() => { /* genres are a nice-to-have; search still works */ });

// ---------- requesting ----------

async function requestTrack(track, btn, message, sendBtn) {
  sendBtn.disabled = true;
  sendBtn.textContent = '…';
  try {
    const { request, queueError } = await api('/api/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackId: track.id, guestName: $('name').value, message }),
    });
    closeComposer();
    btn.textContent = 'Sent ✓';
    btn.disabled = true;
    if (request.status === 'queued') toast(`“${track.name}” is in the queue! Check the Queue tab to see where.`);
    else if (queueError) toast(`Saved “${track.name}”, but the music isn't playing right now. It'll be added as soon as it starts.`, true);
    else toast(`Requested “${track.name}” — the host will add it soon.`);
    refresh();
  } catch (err) {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
    toast(err.message, true);
  }
}

// ---------- live state ----------

function renderPlayer(state, requestedBy) {
  const p = state.player;
  const np = p?.nowPlaying;
  $('now').hidden = !np;
  if (np) {
    $('nowArt').src = np.art || np.thumb || '';
    $('nowTitle').textContent = np.name;
    $('nowArtist').textContent = np.artists;
    $('nowLabel').textContent = p.isPlaying ? 'Now playing' : 'Paused';
    $('nowProgress').style.width = np.durationMs ? `${Math.min(100, (p.progressMs / np.durationMs) * 100)}%` : '0';
    const r = requestedBy.get(np.uri);
    $('nowBy').textContent = r ? `asked for by ${r.guestName}` : '';
    $('nowBy').hidden = !r;
    $('nowMsg').textContent = r?.message || '';
    $('nowMsg').hidden = !r?.message;
  }

  let banner = '';
  if (!state.connected) banner = "The jukebox isn't connected to Spotify yet — hang tight.";
  else if (state.settings.paused) banner = 'Requests are paused for now.';
  $('banner').textContent = banner;
  $('banner').hidden = !banner;
}

// Where one of your queued songs is: playing, #N in the queue, or already played.
function queuePosition(r, state) {
  const upNext = state.player?.upNext || [];
  if (state.player?.nowPlaying?.uri === r.track.uri) return status('queued', 'Playing now 🎶');
  const i = upNext.findIndex(t => t?.uri === r.track.uri);
  if (i >= 0) return status('queued', `#${i + 1} in queue`);
  // Spotify only shows the next ~20 songs; beyond that we can't tell "far back" from "already played".
  if (upNext.length >= 20) return status('queued', 'In the queue');
  return status('rejected', 'Played ✓');
}

function renderQueue(state, requestedBy) {
  const myUris = new Set(state.mine.filter(r => r.status !== 'rejected').map(r => r.track.uri));

  // Your requests, with live position
  $('mineSection').hidden = !state.mine.length;
  $('mine').replaceChildren(...state.mine.map(r => trackRow(r.track,
    r.status === 'queued' ? queuePosition(r, state)
      : r.status === 'pending' ? status('pending', 'Waiting for host')
        : status('rejected', 'Not this time'),
    r.message ? el('div', { className: 'msg', textContent: r.message }) : null)));

  // Spotify's real queue, numbered, with your songs highlighted
  const upNext = (state.player?.upNext || []).filter(Boolean);
  $('upNext').replaceChildren(...upNext.map(t => {
    const r = requestedBy.get(t.uri);
    return trackRow(t, null, r ? byLine(r) : null, { mine: myUris.has(t.uri) });
  }));
  $('upNextEmpty').hidden = upNext.length > 0;

  // Requests the host hasn't approved yet
  const pending = state.requests.filter(r => r.status === 'pending').reverse();
  $('pendingSection').hidden = !pending.length;
  $('pending').replaceChildren(...pending.map(r =>
    trackRow(r.track, status('pending', 'Awaiting host'), byLine(r), { mine: myUris.has(r.track.uri) })));

  const count = upNext.length + pending.length;
  $('queueCount').textContent = count ? count : '';
}

async function refresh() {
  try {
    const state = await api('/api/state');
    const requestedBy = new Map();
    for (const r of state.requests) {
      if (r.status === 'queued' && !requestedBy.has(r.track.uri)) requestedBy.set(r.track.uri, r);
    }
    renderPlayer(state, requestedBy);
    renderQueue(state, requestedBy);
  } catch { /* keep the last good render; try again next tick */ }
}

refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
