<?php
// ============================================================
//  Bozza's Jukebox — JSON API for the guest and host pages.
//  api.php?a=<action>. Host actions (a=host/...) need the host cookie
//  that host.php sets after the host passcode is entered.
//  api.php?ping=1 confirms which version is live (no login needed).
// ============================================================

declare(strict_types=1);

const API_VERSION = 1;

// Safety net: turn a PHP fatal error into JSON so the page shows a message, not a blank 500.
register_shutdown_function(function () {
    $e = error_get_last();
    if ($e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        if (!headers_sent()) { http_response_code(500); header('Content-Type: application/json; charset=utf-8'); }
        echo json_encode(['error' => 'SERVER_ERROR', 'message' => 'Something went wrong on the server.']);
    }
});

require __DIR__ . '/private/lib.php';

if (isset($_GET['ping'])) json_out(200, ['pong' => true, 'version' => API_VERSION]);

function read_json(): array
{
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') throw new ApiError(405, 'BAD_REQUEST', 'Expected POST.');
    // Requiring JSON also stops other sites from submitting forms here on a guest's behalf.
    if (stripos($_SERVER['CONTENT_TYPE'] ?? '', 'application/json') === false) throw new ApiError(415, 'BAD_REQUEST', 'Expected JSON.');
    $raw = (string) file_get_contents('php://input', false, null, 0, 10001);
    if (strlen($raw) > 10000) throw new ApiError(413, 'BAD_REQUEST', 'Request too large.');
    $data = json_decode($raw ?: '{}', true);
    if (!is_array($data)) throw new ApiError(400, 'BAD_REQUEST', 'Invalid JSON.');
    return $data;
}

function guest_state(): array
{
    $s = read_store('state');
    $set = array_merge(DEFAULT_SETTINGS, $s['settings'] ?? []);
    $requests = $s['requests'] ?? [];
    $guest = guest_id();
    $live = array_values(array_filter($requests, function ($r) { return $r['status'] === 'pending' || $r['status'] === 'queued'; }));
    $mine = array_values(array_filter($requests, function ($r) use ($guest) { return $r['guestId'] === $guest; }));
    $connected = is_connected();
    return [
        'connected' => $connected,
        'player' => $connected ? get_player() : null,
        'settings' => ['autoApprove' => $set['autoApprove'], 'allowExplicit' => $set['allowExplicit'], 'paused' => $set['paused']],
        'requests' => array_map('public_request', array_reverse(array_slice($live, -30))),
        'mine' => array_map('public_request', array_reverse(array_slice($mine, -10))),
    ];
}

function make_request(array $body): array
{
    if (!is_connected()) throw new ApiError(503, 'NOT_CONNECTED', "The host hasn't connected Spotify yet.");
    $trackId = (string) ($body['trackId'] ?? '');
    if (!preg_match('/^[A-Za-z0-9]{22}$/', $trackId)) throw new ApiError(400, 'UNKNOWN_TRACK', 'Search for the song again, then request it.');
    $track = get_track($trackId);
    $guest = guest_id();
    $host = is_host();
    $name = mb_substr(trim((string) ($body['guestName'] ?? '')), 0, 30) ?: 'Someone';
    $message = mb_substr(trim((string) preg_replace('/\s+/u', ' ', (string) ($body['message'] ?? ''))), 0, MESSAGE_MAX);

    [$r, $autoApprove] = with_store('state', function (array &$s) use ($track, $guest, $host, $name, $message) {
        $set = array_merge(DEFAULT_SETTINGS, $s['settings'] ?? []);
        $now = now_ms();
        $requests = $s['requests'] ?? [];
        if ($set['paused'] && !$host) throw new ApiError(403, 'PAUSED', 'Requests are paused right now.');
        if ($track['explicit'] && !$set['allowExplicit']) throw new ApiError(403, 'EXPLICIT', 'Explicit songs are turned off tonight.');

        foreach ($requests as $x) {
            if ($x['track']['id'] === $track['id']
                && ($x['status'] === 'pending' || ($x['status'] === 'queued' && $now - (int) $x['decidedAt'] < 3600000))) {
                throw new ApiError(409, 'DUPLICATE', 'Someone already requested that one!');
            }
            if (!$host && $x['track']['id'] === $track['id'] && $x['status'] === 'removed' && $now - (int) $x['decidedAt'] < 3600000) {
                throw new ApiError(409, 'REMOVED', 'The host took that one off the queue.');
            }
        }

        if (!$host) {
            $pending = count(array_filter($requests, function ($x) use ($guest) { return $x['guestId'] === $guest && $x['status'] === 'pending'; }));
            if ($pending >= $set['maxPendingPerGuest']) {
                throw new ApiError(429, 'TOO_MANY', "You have $pending songs waiting — hang on until the host gets to them.");
            }
            $wait = (int) ceil((($s['lastRequestAt'][$guest] ?? 0) + $set['cooldownSec'] * 1000 - $now) / 1000);
            if ($wait > 0) throw new ApiError(429, 'COOLDOWN', "You can request again in {$wait}s.");
        }

        $r = [
            'id' => bin2hex(random_bytes(6)),
            'track' => $track,
            'guestId' => $guest,
            'guestName' => $name,
            'message' => $message,
            'status' => 'pending',
            'createdAt' => $now,
            'decidedAt' => null,
            'error' => null,
        ];
        $requests[] = $r;
        $s['requests'] = array_slice($requests, -MAX_REQUESTS_KEPT);
        $s['lastRequestAt'][$guest] = $now;
        foreach ($s['lastRequestAt'] as $g => $t) if ($now - $t > 86400000) unset($s['lastRequestAt'][$g]);
        return [$r, $set['autoApprove']];
    });

    $queueError = null;
    if ($autoApprove) {
        // If Spotify rejects it (e.g. nothing playing), leave it pending; retry_stalled() or the host picks it up.
        try {
            queue_request($r['id']);
        } catch (ApiError $e) {
            $queueError = $e->getMessage();
            with_store('state', function (array &$s) use ($guest) { unset($s['lastRequestAt'][$guest]); });
        }
        $r = find_request($r['id']);
    }
    $out = ['request' => public_request($r)];
    if ($queueError) $out['queueError'] = $queueError;
    return $out;
}

function pending_request(array $body): string
{
    $id = (string) ($body['id'] ?? '');
    $r = find_request($id);
    if ($r['status'] !== 'pending') throw new ApiError(409, 'NOT_PENDING', 'That request was already handled.');
    return $id;
}

function host_action(string $action): array
{
    if (!is_host()) throw new ApiError(403, 'FORBIDDEN', 'Host only — log in again on the host page.');

    if ($action === 'host/state') {
        $s = read_store('state');
        $connected = is_connected();
        return [
            'connected' => $connected,
            'guestUrls' => [base_url()],
            'settings' => array_merge(DEFAULT_SETTINGS, $s['settings'] ?? []),
            'player' => $connected ? get_player() : null,
            'requests' => array_map(function ($r) { return public_request($r) + ['error' => $r['error'] ?? null]; },
                array_reverse(array_slice($s['requests'] ?? [], -100))),
        ];
    }

    $body = read_json();
    switch ($action) {
        case 'host/approve':
            queue_request(pending_request($body));
            return ['ok' => true];

        case 'host/reject':
            update_request(pending_request($body), function (array &$r) {
                $r['status'] = 'rejected';
                $r['decidedAt'] = now_ms();
            });
            return ['ok' => true];

        case 'host/approve-all':
            $queued = 0;
            foreach (read_store('state')['requests'] ?? [] as $r) {
                if ($r['status'] !== 'pending') continue;
                try {
                    queue_request($r['id']);
                    $queued++;
                } catch (ApiError $e) {
                    if ($e->errCode === 'NO_ACTIVE_DEVICE') throw $e;
                }
            }
            return ['ok' => true, 'queued' => $queued];

        case 'host/clear-message':
            update_request((string) ($body['id'] ?? ''), function (array &$r) { $r['message'] = ''; });
            return ['ok' => true];

        case 'host/settings':
            $settings = with_store('state', function (array &$s) use ($body) {
                $set = array_merge(DEFAULT_SETTINGS, $s['settings'] ?? []);
                foreach (['autoApprove', 'allowExplicit', 'paused'] as $k) {
                    if (is_bool($body[$k] ?? null)) $set[$k] = $body[$k];
                }
                if (is_int($body['maxPendingPerGuest'] ?? null)) $set['maxPendingPerGuest'] = min(max($body['maxPendingPerGuest'], 1), 50);
                if (is_int($body['cooldownSec'] ?? null)) $set['cooldownSec'] = min(max($body['cooldownSec'], 0), 3600);
                $s['settings'] = $set;
                return $set;
            });
            return ['settings' => $settings];

        case 'host/remove':
            // Take a song off the queue (see apply_removals), and mark the guest's request as removed.
            $uri = (string) ($body['uri'] ?? '');
            if (!preg_match('/^spotify:(track|episode):[A-Za-z0-9]{22}$/', $uri)) throw new ApiError(400, 'BAD_REQUEST', 'Unknown song.');
            $requestId = (string) ($body['requestId'] ?? '');
            with_store('state', function (array &$s) use ($uri, $requestId) {
                $s['removed'] = array_slice(array_merge($s['removed'] ?? [], [$uri]), -50);
                foreach ($s['requests'] ?? [] as $i => $r) {
                    if ($r['id'] === $requestId && $r['status'] === 'queued' && $r['track']['uri'] === $uri) {
                        $s['requests'][$i]['status'] = 'removed';
                        $s['requests'][$i]['decidedAt'] = now_ms();
                    }
                }
            });
            invalidate_player();
            return ['ok' => true];

        case 'host/play-pause':
            spotify('PUT', empty($body['play']) ? '/me/player/pause' : '/me/player/play');
            invalidate_player();
            return ['ok' => true];

        case 'host/skip':
            spotify('POST', '/me/player/next');
            invalidate_player();
            return ['ok' => true];

        case 'host/disconnect':
            write_store('auth', []);
            invalidate_player();
            return ['ok' => true];
    }
    throw new ApiError(404, 'NOT_FOUND', 'Unknown action.');
}

try {
    $action = (string) ($_GET['a'] ?? '');
    guest_id(); // make sure every visitor has a guest cookie

    if (strpos($action, 'host/') === 0) json_out(200, host_action($action));

    switch ($action) {
        case 'state':
            json_out(200, guest_state());

        case 'search':
            $q = mb_substr(trim((string) ($_GET['q'] ?? '')), 0, 100);
            if ($q === '') json_out(200, ['tracks' => []]);
            if (!is_host()) check_rate('search', guest_id(), 40, 60, 'Slow down a little — too many searches.');
            json_out(200, ['tracks' => for_guests(cached_track_search($q, 600))]);

        case 'genres':
            json_out(200, ['genres' => array_map(function ($g) { return ['key' => $g['key'], 'label' => $g['label']]; }, genres())]);

        case 'browse':
            $key = (string) ($_GET['genre'] ?? '');
            $genre = null;
            foreach (genres() as $g) if ($g['key'] === $key) $genre = $g;
            if (!$genre) throw new ApiError(404, 'NOT_FOUND', 'Unknown genre.');
            if (!is_host()) check_rate('search', guest_id(), 40, 60, 'Slow down a little — too many searches.');
            $result = browse_genre($genre, max(0, (int) ($_GET['page'] ?? 0)));
            json_out(200, ['tracks' => for_guests($result['tracks']), 'hasMore' => $result['hasMore']]);

        case 'request':
            json_out(200, make_request(read_json()));
    }
    throw new ApiError(404, 'NOT_FOUND', 'Unknown action.');
} catch (ApiError $e) {
    json_out($e->status, ['error' => $e->errCode, 'message' => $e->getMessage()]);
} catch (Throwable $e) {
    error_log('jukebox: ' . $e);
    json_out(500, ['error' => 'SERVER_ERROR', 'message' => 'Something went wrong.']);
}
