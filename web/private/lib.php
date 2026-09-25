<?php
// ============================================================
//  Bozza's Jukebox — server code shared by api.php, host.php,
//  login.php and callback.php. Guests search and request songs;
//  the host's Spotify account plays them.
//
//  State lives in small JSON files in private/data/, each read and
//  written under flock so simultaneous requests can't corrupt them.
//  You do not need to edit this file — only config.php.
// ============================================================

declare(strict_types=1);

// Warnings go to the server's error log, never into a JSON response where they'd break the page.
ini_set('display_errors', '0');
ini_set('log_errors', '1');

if (!is_file(__DIR__ . '/config.php')) {
    http_response_code(500);
    exit('Missing private/config.php. Copy private/config.example.php to config.php and fill it in.');
}
require __DIR__ . '/config.php';

// Overridable for local testing against a fake Spotify; production never sets these.
if (!defined('SPOTIFY_API')) define('SPOTIFY_API', 'https://api.spotify.com/v1');
if (!defined('SPOTIFY_ACCOUNTS')) define('SPOTIFY_ACCOUNTS', 'https://accounts.spotify.com');
if (!defined('PUBLIC_URL')) define('PUBLIC_URL', '');

const DATA_DIR = __DIR__ . '/data';
const MESSAGE_MAX = 140;
const MAX_REQUESTS_KEPT = 300;
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';
const DEFAULT_SETTINGS = [
    'autoApprove' => false,      // queue requests straight to Spotify without host approval
    'allowExplicit' => true,
    'paused' => false,           // stop accepting new requests
    'maxPendingPerGuest' => 3,   // how many unapproved requests one guest can have at once
    'cooldownSec' => 60,         // minimum gap between requests from one guest
];

class ApiError extends Exception
{
    public int $status;
    public string $errCode;

    public function __construct(int $status, string $errCode, string $message)
    {
        parent::__construct($message);
        $this->status = $status;
        $this->errCode = $errCode;
    }
}

function now_ms(): int
{
    return (int) round(microtime(true) * 1000);
}

// ---------- storage ----------

function ensure_data_dir(): void
{
    if (!is_dir(DATA_DIR . '/cache') && !@mkdir(DATA_DIR . '/cache', 0700, true) && !is_dir(DATA_DIR . '/cache')) {
        throw new ApiError(500, 'STORAGE', 'The jukebox cannot create its data folder (private/data).');
    }
}

function store_path(string $name): string
{
    return DATA_DIR . '/' . $name . '.json';
}

function decode_store($raw, array $default): array
{
    $data = is_string($raw) && $raw !== '' ? json_decode($raw, true) : null;
    return is_array($data) ? $data : $default;
}

function read_store(string $name, array $default = []): array
{
    $fh = @fopen(store_path($name), 'r');
    if (!$fh) return $default;
    flock($fh, LOCK_SH);
    $raw = stream_get_contents($fh);
    flock($fh, LOCK_UN);
    fclose($fh);
    return decode_store($raw, $default);
}

// Read-modify-write under an exclusive lock. $fn receives the data by reference and its
// return value is passed back. If $fn throws, nothing is written.
function with_store(string $name, callable $fn, array $default = [])
{
    ensure_data_dir();
    $fh = fopen(store_path($name), 'c+');
    if (!$fh) throw new ApiError(500, 'STORAGE', 'The jukebox cannot open its data file.');
    try {
        flock($fh, LOCK_EX);
        $raw = stream_get_contents($fh);
        $data = decode_store($raw, $default);
        $result = $fn($data);
        $json = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($json !== $raw) {
            ftruncate($fh, 0);
            rewind($fh);
            fwrite($fh, $json);
            fflush($fh);
        }
        return $result;
    } finally {
        flock($fh, LOCK_UN);
        fclose($fh);
    }
}

function write_store(string $name, array $value): void
{
    with_store($name, function (array &$data) use ($value) { $data = $value; });
}

// A lock only one request can hold; the others skip the work instead of queueing up behind it.
function try_lock(string $name)
{
    ensure_data_dir();
    $fh = fopen(DATA_DIR . '/' . $name . '.lock', 'c');
    if ($fh && flock($fh, LOCK_EX | LOCK_NB)) return $fh;
    if ($fh) fclose($fh);
    return null;
}

function release_lock($fh): void
{
    flock($fh, LOCK_UN);
    fclose($fh);
}

function settings(): array
{
    return array_merge(DEFAULT_SETTINGS, read_store('state')['settings'] ?? []);
}

// ---------- cookies, identity, URLs ----------

function is_https(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || ($_SERVER['SERVER_PORT'] ?? '') === '443'
        || strtolower($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
}

// The folder the app is served from, e.g. "/jukebox/".
function app_path(): string
{
    return rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/') . '/';
}

function base_url(): string
{
    if (PUBLIC_URL !== '') return rtrim(PUBLIC_URL, '/') . '/';
    return (is_https() ? 'https' : 'http') . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost') . app_path();
}

function redirect_uri(): string
{
    return base_url() . 'callback.php';
}

function set_cookie(string $name, string $value, int $maxAge): void
{
    setcookie($name, $value, [
        'expires' => $maxAge > 0 ? time() + $maxAge : 1,
        'path' => app_path(),
        'secure' => is_https(),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

function guest_id(): string
{
    static $id = null;
    if ($id !== null) return $id;
    $id = (string) ($_COOKIE['jb_guest'] ?? '');
    if (!preg_match('/^[a-f0-9]{24}$/', $id)) {
        $id = bin2hex(random_bytes(12));
        set_cookie('jb_guest', $id, 31536000);
    }
    return $id;
}

function host_key_ok(): bool
{
    return defined('HOST_KEY') && strlen(HOST_KEY) >= 8 && HOST_KEY !== 'choose-a-long-passphrase';
}

function host_token(): string
{
    return hash_hmac('sha256', 'bozza-jukebox-host', HOST_KEY);
}

function is_host(): bool
{
    return host_key_ok() && hash_equals(host_token(), (string) ($_COOKIE['jb_host'] ?? ''));
}

function client_ip(): string
{
    return (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
}

// Sliding-window rate limit, e.g. 40 searches a minute per guest.
function check_rate(string $bucket, string $who, int $max, int $windowSec, string $message): void
{
    $ok = with_store('rate', function (array &$r) use ($bucket, $who, $max, $windowSec) {
        $now = time();
        $key = $bucket . ':' . $who;
        $hits = array_values(array_filter($r[$key] ?? [], function ($t) use ($now, $windowSec) { return $now - $t < $windowSec; }));
        $allowed = count($hits) < $max;
        if ($allowed) $hits[] = $now;
        $r[$key] = $hits;
        if (mt_rand(1, 50) === 1) { // prune keys nobody has used for an hour
            foreach ($r as $k => $v) if (!$v || $now - max($v) > 3600) unset($r[$k]);
        }
        return $allowed;
    });
    if (!$ok) throw new ApiError(429, 'RATE_LIMITED', $message);
}

// ---------- Spotify ----------

function http_call(string $method, string $url, array $headers = [], ?string $body = null): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_TIMEOUT => 15,
    ]);
    // Spotify rejects a POST without a Content-Length, so always send a body, even an empty one.
    if ($body !== null || $method === 'POST' || $method === 'PUT') curl_setopt($ch, CURLOPT_POSTFIELDS, $body ?? '');
    $resp = curl_exec($ch);
    if ($resp === false) {
        $err = curl_error($ch);
        throw new ApiError(502, 'NETWORK', "Couldn't reach Spotify ($err).");
    }
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    return [$status, (string) $resp];
}

function token_request(array $params): void
{
    [$status, $raw] = http_call('POST', SPOTIFY_ACCOUNTS . '/api/token', [
        'Content-Type: application/x-www-form-urlencoded',
        'Authorization: Basic ' . base64_encode(SPOTIFY_CLIENT_ID . ':' . SPOTIFY_CLIENT_SECRET),
    ], http_build_query($params));
    $data = json_decode($raw, true) ?: [];
    if ($status !== 200 || empty($data['access_token'])) {
        if (($data['error'] ?? '') === 'invalid_grant' && ($params['grant_type'] ?? '') === 'refresh_token') {
            // Revoked or expired: the host has to connect again.
            with_store('auth', function (array &$a) { $a = []; });
        }
        throw new ApiError(502, 'AUTH_FAILED', (string) ($data['error_description'] ?? $data['error'] ?? "Spotify login failed ($status)."));
    }
    with_store('auth', function (array &$a) use ($data) {
        $a['accessToken'] = $data['access_token'];
        $a['expiresAt'] = time() + (int) $data['expires_in'];
        if (!empty($data['refresh_token'])) $a['refreshToken'] = $data['refresh_token'];
    });
}

function is_connected(): bool
{
    return !empty(read_store('auth')['refreshToken']);
}

function access_token(): string
{
    $a = read_store('auth');
    if (!empty($a['accessToken']) && time() < ($a['expiresAt'] ?? 0) - 60) return $a['accessToken'];
    if (empty($a['refreshToken'])) throw new ApiError(503, 'NOT_CONNECTED', "The host hasn't connected Spotify yet.");
    token_request(['grant_type' => 'refresh_token', 'refresh_token' => $a['refreshToken']]);
    return read_store('auth')['accessToken'];
}

function spotify(string $method, string $path, array $query = [], bool $retry = true)
{
    $url = SPOTIFY_API . $path . ($query ? '?' . http_build_query($query, '', '&', PHP_QUERY_RFC3986) : '');
    [$status, $raw] = http_call($method, $url, ['Authorization: Bearer ' . access_token()]);
    if ($status === 401 && $retry) {
        with_store('auth', function (array &$a) { unset($a['accessToken']); });
        return spotify($method, $path, $query, false);
    }
    $data = $raw !== '' ? json_decode($raw, true) : null;
    if ($status >= 200 && $status < 300) return $data;

    $reason = $data['error']['reason'] ?? '';
    $message = $data['error']['message'] ?? "Spotify returned $status";
    if ($reason === 'NO_ACTIVE_DEVICE' || ($status === 404 && stripos($message, 'device') !== false)) {
        throw new ApiError(409, 'NO_ACTIVE_DEVICE', "Spotify isn't playing on any device. Start playback on the host's Spotify, then try again.");
    }
    if ($reason === 'PREMIUM_REQUIRED') {
        throw new ApiError(403, 'PREMIUM_REQUIRED', 'Adding to the queue needs Spotify Premium on the host account.');
    }
    if ($status === 429) throw new ApiError(429, 'RATE_LIMITED', 'Spotify is busy — try again in a few seconds.');
    throw new ApiError(502, 'SPOTIFY_ERROR', $message);
}

function to_item($t): ?array
{
    if (!is_array($t)) return null;
    $images = $t['album']['images'] ?? $t['images'] ?? $t['show']['images'] ?? [];
    return [
        'id' => $t['id'] ?? '',
        'uri' => $t['uri'] ?? '',
        'name' => $t['name'] ?? '',
        'artists' => isset($t['artists']) ? implode(', ', array_column($t['artists'], 'name')) : ($t['show']['name'] ?? ''),
        'album' => $t['album']['name'] ?? '',
        'art' => ($images[1] ?? $images[0] ?? [])['url'] ?? '',
        'thumb' => $images ? ($images[count($images) - 1]['url'] ?? '') : '',
        'explicit' => !empty($t['explicit']),
        'durationMs' => (int) ($t['duration_ms'] ?? 0),
    ];
}

// Search results are shared by every guest, so a room full of people browsing the same
// genre costs Spotify one call, not one each.
function cached_track_search(string $q, int $ttlSec): array
{
    ensure_data_dir();
    $file = DATA_DIR . '/cache/' . md5('search:' . mb_strtolower($q)) . '.json';
    if (is_file($file) && time() - filemtime($file) < $ttlSec) {
        $hit = json_decode((string) file_get_contents($file), true);
        if (is_array($hit)) return $hit;
    }
    $data = spotify('GET', '/search', ['q' => $q, 'type' => 'track', 'limit' => 10]);
    $tracks = array_values(array_filter(array_map('to_item', $data['tracks']['items'] ?? [])));
    file_put_contents($file, json_encode($tracks, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX);
    if (mt_rand(1, 100) === 1) prune_cache();
    return $tracks;
}

function prune_cache(): void
{
    foreach (glob(DATA_DIR . '/cache/*.json') ?: [] as $f) {
        if (time() - filemtime($f) > 86400) @unlink($f);
    }
}

function get_track(string $id): array
{
    $file = DATA_DIR . '/cache/track-' . $id . '.json';
    if (is_file($file)) {
        $hit = json_decode((string) file_get_contents($file), true);
        if (is_array($hit)) return $hit;
    }
    $track = to_item(spotify('GET', '/tracks/' . $id));
    if (!$track || !$track['uri']) throw new ApiError(404, 'UNKNOWN_TRACK', "Couldn't find that song — search for it again.");
    ensure_data_dir();
    file_put_contents($file, json_encode($track, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX);
    return $track;
}

function for_guests(array $tracks): array
{
    $allowExplicit = settings()['allowExplicit'];
    return array_map(function ($t) use ($allowExplicit) {
        $t['blocked'] = $t['explicit'] && !$allowExplicit;
        return $t;
    }, $tracks);
}

// ---------- now playing ----------

function empty_player(): array
{
    return ['isPlaying' => false, 'progressMs' => 0, 'nowPlaying' => null, 'upNext' => []];
}

// Cached for a few seconds so a room full of phones polling doesn't hammer Spotify.
// Only one request refreshes it; the rest get the last copy in the meantime.
function get_player(): array
{
    $cached = read_store('player');
    if (isset($cached['at']) && microtime(true) - $cached['at'] < 4) return $cached['data'];
    $lock = try_lock('player');
    if (!$lock) return $cached['data'] ?? empty_player();
    try {
        try {
            $current = spotify('GET', '/me/player/currently-playing');
            try { $queue = spotify('GET', '/me/player/queue'); } catch (ApiError $e) { $queue = null; }
            $data = [
                'isPlaying' => !empty($current['is_playing']),
                'progressMs' => (int) ($current['progress_ms'] ?? 0),
                'nowPlaying' => to_item($current['item'] ?? null),
                'upNext' => array_values(array_filter(array_map('to_item', array_slice($queue['queue'] ?? [], 0, 20)))),
            ];
            [$data, $skipped] = apply_removals($data, $queue === null ? null : array_column($queue['queue'] ?? [], 'uri'));
        } catch (ApiError $e) {
            $data = empty_player() + ['error' => $e->errCode];
            $skipped = false;
        }
        // After skipping a removed song, look again on the next poll instead of trusting this copy.
        write_store('player', ['at' => $skipped ? 0 : microtime(true), 'data' => $data]);
    } finally {
        release_lock($lock);
    }
    if ($data['nowPlaying']) retry_stalled();
    return $data;
}

// Spotify has no way to take a song out of its queue. So a song the host removes is hidden
// from everyone's view of the queue here, and skipped the moment Spotify starts playing it.
// $queueUris is Spotify's whole queue, or null if it couldn't be fetched.
function apply_removals(array $data, ?array $queueUris): array
{
    if (empty(read_store('state')['removed'])) return [$data, false];
    $skip = with_store('state', function (array &$s) use (&$data, $queueUris) {
        $removed = $s['removed'] ?? [];
        $np = $data['nowPlaying']['uri'] ?? '';
        $skip = false;
        $i = array_search($np, $removed, true);
        if ($np !== '' && $i !== false) {
            unset($removed[$i]);
            $skip = true;
        }
        // Forget songs that left Spotify's queue some other way (the host cleared it or started a new playlist).
        if ($queueUris !== null) {
            $removed = array_filter($removed, function ($uri) use ($queueUris) { return in_array($uri, $queueUris, true); });
        }
        $s['removed'] = array_values($removed);

        $hide = array_count_values($s['removed']);
        $data['upNext'] = array_values(array_filter($data['upNext'], function ($t) use (&$hide) {
            if (empty($hide[$t['uri']])) return true;
            $hide[$t['uri']]--;
            return false;
        }));
        return $skip;
    });
    if ($skip) {
        try { spotify('POST', '/me/player/next'); } catch (ApiError $e) { return [$data, false]; }
        // Spotify moves on to the next song; show that until the next poll confirms it.
        $data['nowPlaying'] = $data['upNext'] ? array_shift($data['upNext']) : null;
        $data['progressMs'] = 0;
    }
    return [$data, $skip];
}

function invalidate_player(): void
{
    with_store('player', function (array &$p) { $p['at'] = 0; });
}

// ---------- requests ----------

function public_request(array $r): array
{
    return [
        'id' => $r['id'],
        'track' => $r['track'],
        'guestName' => $r['guestName'],
        'message' => $r['message'] ?? '',
        'status' => $r['status'],
        'createdAt' => $r['createdAt'],
    ];
}

function find_request(string $id): array
{
    foreach (read_store('state')['requests'] ?? [] as $r) if ($r['id'] === $id) return $r;
    throw new ApiError(404, 'NOT_FOUND', 'Request not found.');
}

// Apply $fn to one stored request, under the state lock.
function update_request(string $id, callable $fn)
{
    return with_store('state', function (array &$s) use ($id, $fn) {
        foreach ($s['requests'] ?? [] as $i => $r) {
            if ($r['id'] === $id) {
                $result = $fn($r);
                $s['requests'][$i] = $r;
                return $result;
            }
        }
        throw new ApiError(404, 'NOT_FOUND', 'Request not found.');
    });
}

function queue_request(string $id): void
{
    $r = find_request($id);
    try {
        spotify('POST', '/me/player/queue', ['uri' => $r['track']['uri']]);
    } catch (ApiError $e) {
        update_request($id, function (array &$r) use ($e) { $r['error'] = $e->getMessage(); });
        throw $e;
    }
    update_request($id, function (array &$r) {
        $r['status'] = 'queued';
        $r['decidedAt'] = now_ms();
        $r['error'] = null;
    });
    invalidate_player();
}

// With auto-approve on, a request that arrived while nothing was playing is left pending
// with an error. Once Spotify has an active device again, queue those in request order.
function retry_stalled(): void
{
    if (!settings()['autoApprove']) return;
    $lock = try_lock('retry');
    if (!$lock) return;
    try {
        foreach (read_store('state')['requests'] ?? [] as $r) {
            if ($r['status'] !== 'pending' || empty($r['error'])) continue;
            try { queue_request($r['id']); } catch (ApiError $e) { break; }
        }
    } finally {
        release_lock($lock);
    }
}

// ---------- genre browsing ----------
// Spotify's genre: search filter is unreliable (hip-hop comes back as obscure tracks),
// so each genre is a curated artist list in genres.json. A page is the top search hits
// for a few of them. Decades add a year filter so "80s" gets Madonna's 80s songs.

const ARTISTS_PER_PAGE = 4;
const TRACKS_PER_ARTIST = 3;

function genres(): array
{
    static $genres = null;
    return $genres ??= json_decode((string) file_get_contents(__DIR__ . '/genres.json'), true);
}

function browse_genre(array $genre, int $page): array
{
    $artists = array_slice($genre['artists'], $page * ARTISTS_PER_PAGE, ARTISTS_PER_PAGE);
    $perArtist = [];
    foreach ($artists as $a) {
        $q = 'artist:"' . $a . '"' . (!empty($genre['year']) ? ' year:' . $genre['year'] : '');
        try {
            $perArtist[] = cached_track_search($q, 6 * 3600);
        } catch (ApiError $e) {
            if ($e->errCode === 'NOT_CONNECTED') throw $e;
            $perArtist[] = [];
        }
    }
    // Take each artist's top few (skipping re-releases of the same song), then interleave for variety.
    $seen = [];
    $picks = [];
    foreach ($perArtist as $tracks) {
        $list = [];
        foreach ($tracks as $t) {
            $key = mb_strtolower(preg_replace('/\s*[-(\[].*$/u', '', $t['name'])) . '|' . mb_strtolower(explode(',', $t['artists'])[0]);
            if (isset($seen[$key])) continue;
            $seen[$key] = true;
            $list[] = $t;
            if (count($list) === TRACKS_PER_ARTIST) break;
        }
        $picks[] = $list;
    }
    $out = [];
    for ($i = 0; $i < TRACKS_PER_ARTIST; $i++) foreach ($picks as $list) if (isset($list[$i])) $out[] = $list[$i];
    return ['tracks' => $out, 'hasMore' => ($page + 1) * ARTISTS_PER_PAGE < count($genre['artists'])];
}

// ---------- responses ----------

function json_out(int $status, array $data): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function redirect_to(string $location): void
{
    header('Cache-Control: no-store');
    header('Location: ' . $location, true, 302);
    exit;
}
