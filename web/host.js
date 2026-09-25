const $ = id => document.getElementById(id);

const SETTINGS_TOGGLES = ['autoApprove', 'allowExplicit', 'paused'];
const SETTINGS_NUMBERS = ['maxPendingPerGuest', 'cooldownSec'];

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) if (c != null) node.append(c);
  return node;
}

let toastTimer;
function toast(message, isError = false) {
  const t = $('toast');
  t.textContent = message;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast' + (isError ? ' error' : ''); }, 4000);
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'Something went wrong.');
  return data;
}

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function requestRow(r, right) {
  const title = el('div', { className: 'title', textContent: r.track.name });
  if (r.track.explicit) title.append(el('span', { className: 'tag', textContent: 'E' }));
  return el('li', { className: 'row' }, [
    el('img', { src: r.track.thumb || '', alt: '', loading: 'lazy' }),
    el('div', { className: 'meta' }, [
      title,
      el('div', { className: 'sub', textContent: r.track.artists }),
      el('div', { className: 'by', textContent: `${r.guestName} · ${ago(r.createdAt)}` }),
      r.message ? messageLine(r) : null,
      r.error && r.status === 'pending' ? el('div', { className: 'err', textContent: r.error }) : null,
    ]),
    right,
  ]);
}

// A guest's message, with a button to remove it if it shouldn't be shown to everyone.
function messageLine(r) {
  const remove = el('button', { className: 'msg-remove', textContent: '✕', title: 'Remove this message' });
  remove.setAttribute('aria-label', 'Remove this message');
  remove.addEventListener('click', () => act('api.php?a=host/clear-message', r.id, remove, 'Message removed'));
  return el('div', { className: 'msg' }, [el('span', { textContent: r.message }), remove]);
}

// ---------- rendering ----------

let qrFor = '';

function render(state) {
  $('connectBtn').hidden = state.connected;
  $('disconnectBtn').hidden = !state.connected;

  const err = new URLSearchParams(location.search).get('error');
  let banner = '';
  if (!state.connected) banner = 'Connect your Spotify account to start taking requests. You need Spotify Premium to add songs to the queue.';
  else if (state.player?.error === 'NO_ACTIVE_DEVICE' || (state.connected && !state.player?.nowPlaying)) {
    banner = 'Nothing is playing. Start any song in Spotify on the speaker/computer you want to use, so requests have somewhere to go.';
  }
  if (err) banner = `Spotify login failed (${err}). Try connecting again.`;
  $('banner').textContent = banner;
  $('banner').hidden = !banner;

  // QR code for the guest page
  const joinUrl = state.guestUrls[0];
  $('joinUrl').textContent = state.guestUrls.join('  ·  ');
  if (joinUrl !== qrFor && window.QRCode) {
    $('qr').replaceChildren();
    new window.QRCode($('qr'), { text: joinUrl, width: 400, height: 400, correctLevel: window.QRCode.CorrectLevel.M });
    qrFor = joinUrl;
  }

  // settings (don't clobber a field the host is typing in)
  for (const k of SETTINGS_TOGGLES) $(k).checked = state.settings[k];
  for (const k of SETTINGS_NUMBERS) if (document.activeElement !== $(k)) $(k).value = state.settings[k];
  const s = state.settings;
  $('settingsSummary').textContent = [
    s.paused ? 'Requests paused' : s.autoApprove ? 'Auto-approve' : 'Manual approval',
    s.allowExplicit ? 'explicit OK' : 'no explicit',
    `${s.maxPendingPerGuest} max · ${s.cooldownSec}s cooldown`,
  ].join(' · ');

  // now playing
  const p = state.player;
  const np = p?.nowPlaying;
  $('now').hidden = !np;
  if (np) {
    $('nowArt').src = np.art || np.thumb || '';
    $('nowTitle').textContent = np.name;
    $('nowArtist').textContent = np.artists;
    $('nowLabel').textContent = p.isPlaying ? 'Now playing' : 'Paused';
    $('nowProgress').style.width = np.durationMs ? `${Math.min(100, (p.progressMs / np.durationMs) * 100)}%` : '0';
    if (!playPauseBusy) setPlayPause(p.isPlaying);
  }

  renderUpNext(state);
  renderChat(state);

  // requests
  const pending = state.requests.filter(r => r.status === 'pending').reverse(); // oldest first
  const history = state.requests.filter(r => r.status !== 'pending').slice(0, 30);

  $('pendingCount').textContent = pending.length ? `(${pending.length})` : '';
  $('approveAllBtn').hidden = pending.length < 2;
  $('pendingEmpty').hidden = pending.length > 0;
  $('pending').replaceChildren(...pending.map(r => {
    const approve = el('button', { className: 'good', textContent: r.error ? 'Retry' : 'Add' });
    const reject = el('button', { className: 'bad', textContent: 'Skip' });
    approve.addEventListener('click', () => act('api.php?a=host/approve', r.id, approve, `Queued “${r.track.name}”`));
    reject.addEventListener('click', () => act('api.php?a=host/reject', r.id, reject));
    return requestRow(r, el('div', { className: 'actions' }, [approve, reject]));
  }));

  $('historyEmpty').hidden = history.length > 0;
  $('history').replaceChildren(...history.map(r => requestRow(
    r, el('span', { className: 'status ' + r.status, textContent: HISTORY_LABELS[r.status] || 'Skipped' }))));
}

const HISTORY_LABELS = { queued: 'Queued', rejected: 'Skipped', removed: 'Removed' };

// Spotify's queue, with the guest who asked for each song and a button to take it off.
function renderUpNext(state) {
  const upNext = (state.player?.upNext || []).filter(Boolean);
  const requestedBy = new Map();
  for (const r of state.requests) {
    if (r.status === 'queued' && !requestedBy.has(r.track.uri)) requestedBy.set(r.track.uri, r);
  }
  $('upNextCount').textContent = upNext.length ? `(${upNext.length})` : '';
  $('upNextEmpty').hidden = upNext.length > 0;
  $('upNextHint').hidden = upNext.length === 0;
  $('upNext').replaceChildren(...upNext.map(t => {
    const r = requestedBy.get(t.uri);
    const title = el('div', { className: 'title', textContent: t.name });
    if (t.explicit) title.append(el('span', { className: 'tag', textContent: 'E' }));
    const remove = el('button', { className: 'bad remove', textContent: 'Remove' });
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await api('api.php?a=host/remove', { uri: t.uri, requestId: r?.id || '' });
        toast(`Removed “${t.name}”`);
      } catch (err) { toast(err.message, true); }
      refresh();
    });
    return el('li', { className: 'row' }, [
      el('img', { src: t.thumb || '', alt: '', loading: 'lazy' }),
      el('div', { className: 'meta' }, [
        title,
        el('div', { className: 'sub', textContent: t.artists }),
        r ? el('div', { className: 'by', textContent: `Requested by ${r.guestName}` }) : null,
        r?.message ? el('div', { className: 'msg', textContent: r.message }) : null,
      ]),
      remove,
    ]);
  }));
}

// Chat-style log of every message sent with a request, oldest at the top. Shown on wide screens only.
let chatShown = '';
function renderChat(state) {
  const entries = state.requests.filter(r => r.message).sort((a, b) => a.createdAt - b.createdAt);
  const signature = entries.map(r => r.id + r.message).join('|');
  $('chatCount').textContent = entries.length ? `(${entries.length})` : '';
  $('chatEmpty').hidden = entries.length > 0;
  if (signature === chatShown) return;

  const log = $('chatLog');
  const atBottom = !chatShown || log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  chatShown = signature;
  log.replaceChildren(...entries.map(r => {
    const remove = el('button', { className: 'msg-remove', textContent: '✕', title: 'Remove this message' });
    remove.setAttribute('aria-label', 'Remove this message');
    remove.addEventListener('click', () => act('api.php?a=host/clear-message', r.id, remove, 'Message removed'));
    const when = new Date(r.createdAt);
    return el('li', { className: 'chat-entry' }, [
      el('div', { className: 'who' }, [
        el('strong', { textContent: r.guestName }),
        el('time', { dateTime: when.toISOString(), textContent: when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }),
        remove,
      ]),
      el('div', { className: 'bubble', textContent: r.message }),
      el('div', { className: 'song', textContent: `♪ ${r.track.name} — ${r.track.artists}` }),
    ]);
  }));
  // Follow new messages, unless the host has scrolled up to read older ones.
  if (atBottom) log.scrollTop = log.scrollHeight;
}

async function act(path, id, btn, okMessage) {
  btn.disabled = true;
  try {
    await api(path, { id });
    if (okMessage) toast(okMessage);
  } catch (err) {
    toast(err.message, true);
  }
  refresh();
}

// ---------- controls ----------

// Settings panel stays open or closed across reloads
try { $('settingsBox').open = localStorage.getItem('jb_settings_open') !== '0'; } catch { $('settingsBox').open = true; }
$('settingsBox').addEventListener('toggle', () => {
  try { localStorage.setItem('jb_settings_open', $('settingsBox').open ? '1' : '0'); } catch { /* private mode */ }
});

for (const k of SETTINGS_TOGGLES) {
  $(k).addEventListener('change', () => saveSettings({ [k]: $(k).checked }));
}
for (const k of SETTINGS_NUMBERS) {
  $(k).addEventListener('change', () => {
    const n = parseInt($(k).value, 10);
    if (Number.isInteger(n)) saveSettings({ [k]: n });
  });
}

async function saveSettings(patch) {
  try { await api('api.php?a=host/settings', patch); } catch (err) { toast(err.message, true); }
  refresh();
}

let playPauseBusy = false;
function setPlayPause(isPlaying) {
  $('playPauseBtn').textContent = isPlaying ? 'Pause ⏸' : 'Play ▶';
  $('playPauseBtn').dataset.playing = isPlaying ? '1' : '';
}

$('playPauseBtn').addEventListener('click', async () => {
  const play = !$('playPauseBtn').dataset.playing;
  playPauseBusy = true;
  $('playPauseBtn').disabled = true;
  try {
    await api('api.php?a=host/play-pause', { play });
    setPlayPause(play);
  } catch (err) { toast(err.message, true); }
  $('playPauseBtn').disabled = false;
  setTimeout(() => { playPauseBusy = false; refresh(); }, 600);
});

$('skipBtn').addEventListener('click', async () => {
  try { await api('api.php?a=host/skip', {}); } catch (err) { toast(err.message, true); }
  setTimeout(refresh, 600);
});

$('approveAllBtn').addEventListener('click', async () => {
  try {
    const { queued } = await api('api.php?a=host/approve-all', {});
    toast(`Queued ${queued} song${queued === 1 ? '' : 's'}`);
  } catch (err) { toast(err.message, true); }
  refresh();
});

$('disconnectBtn').addEventListener('click', async () => {
  if (!confirm('Disconnect Spotify? Guests won’t be able to request until you reconnect.')) return;
  await api('api.php?a=host/disconnect', {}).catch(err => toast(err.message, true));
  refresh();
});

async function refresh() {
  try {
    render(await api('api.php?a=host/state'));
  } catch (err) {
    toast(err.message, true);
  }
}

refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 4000);
