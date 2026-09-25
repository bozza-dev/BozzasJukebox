<?php
// Fake Spotify for tests (never uploaded): php -S 127.0.0.1:8897 dev/mock-spotify.php
// Serves both the accounts host (/api/token) and the Web API (/v1/...).
// POST /__device turns the "speaker" on; until then queueing fails with NO_ACTIVE_DEVICE.
$stateFile = sys_get_temp_dir() . '/jukebox-mock-' . $_SERVER['SERVER_PORT'] . '.json';
$st = is_file($stateFile) ? json_decode(file_get_contents($stateFile), true) : ['device' => false, 'queue' => []];
$save = function () use (&$st, $stateFile) { file_put_contents($stateFile, json_encode($st)); };
$out = function (int $code, $body = null) { http_response_code($code); if ($body !== null) { header('Content-Type: application/json'); echo json_encode($body); } exit; };
$track = function (string $id, bool $explicit = false) {
    return ['id' => $id, 'uri' => "spotify:track:$id", 'name' => 'Song ' . substr($id, -1), 'explicit' => $explicit, 'duration_ms' => 200000,
        'artists' => [['name' => 'Artist']], 'album' => ['name' => 'Album', 'images' => [['url' => 'L'], ['url' => 'M'], ['url' => 'S']]]];
};
$id = function (string $c) { return str_repeat('a', 21) . $c; };
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$method = $_SERVER['REQUEST_METHOD'];

if ($path === '/__device') { $st['device'] = true; $save(); $out(200, ['ok' => true]); }
if ($path === '/__reset') { @unlink($stateFile); $out(200, ['ok' => true]); }
if ($path === '/api/token') $out(200, ['access_token' => 'AT', 'expires_in' => 3600, 'refresh_token' => 'RT']);
if (($_SERVER['HTTP_AUTHORIZATION'] ?? '') !== 'Bearer AT') $out(401, ['error' => ['status' => 401, 'message' => 'bad token']]);

if ($path === '/v1/search') $out(200, ['tracks' => ['items' => [$track($id('1')), $track($id('2'), true), $track($id('3'))]]]);
if (preg_match('#^/v1/tracks/(\w+)$#', $path, $m)) $out(200, $track($m[1], substr($m[1], -1) === '2'));
if ($path === '/v1/me/player/queue' && $method === 'POST') {
    if (!$st['device']) $out(404, ['error' => ['status' => 404, 'message' => 'Player command failed: No active device found', 'reason' => 'NO_ACTIVE_DEVICE']]);
    if (!isset($_SERVER['CONTENT_LENGTH'])) $out(411, ['error' => ['status' => 411, 'message' => 'Length Required']]);
    $st['queue'][] = $_GET['uri']; $save(); $out(200);
}
if ($path === '/v1/me/player/queue') $out(200, ['queue' => array_map(function ($u) use ($track) { return $track(explode(':', $u)[2]); }, $st['queue'])]);
// 'current' is the playing track's id: "…z" until the first skip, then whatever came off the queue.
$current = array_key_exists('current', $st) ? $st['current'] : $id('z');
if ($path === '/v1/me/player/currently-playing') $st['device'] && $current ? $out(200, ['is_playing' => $st['playing'] ?? true, 'progress_ms' => 1000, 'item' => $track($current)]) : $out(204);
if ($path === '/v1/me/player/next') { $st['current'] = $st['queue'] ? explode(':', array_shift($st['queue']))[2] : null; $save(); $out(204); }
if ($path === '/v1/me/player/pause' && $method === 'PUT') { $st['playing'] = false; $save(); $out(204); }
if ($path === '/v1/me/player/play' && $method === 'PUT') { $st['playing'] = true; $save(); $out(204); }
$out(404, ['error' => ['status' => 404, 'message' => 'nope']]);
