<?php
// Bozza's Jukebox — Spotify sends the host back here after they approve the connection.
// Its full address must be listed as a Redirect URI in the Spotify developer dashboard.

declare(strict_types=1);

require __DIR__ . '/private/lib.php';

$state = (string) ($_GET['state'] ?? '');
$expected = (string) ($_COOKIE['jb_oauth'] ?? '');
set_cookie('jb_oauth', '', 0);

if (!is_host()) redirect_to('host.php');
if ($state === '' || $expected === '' || !hash_equals($expected, $state)) {
    redirect_to('host.php?error=' . rawurlencode('login expired, try again'));
}
if (isset($_GET['error'])) redirect_to('host.php?error=' . rawurlencode((string) $_GET['error']));

try {
    token_request([
        'grant_type' => 'authorization_code',
        'code' => (string) ($_GET['code'] ?? ''),
        'redirect_uri' => redirect_uri(),
    ]);
    invalidate_player();
    redirect_to('host.php');
} catch (ApiError $e) {
    redirect_to('host.php?error=' . rawurlencode($e->getMessage()));
}
