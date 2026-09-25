<?php
// Bozza's Jukebox — sends the host to Spotify to connect their account (host only).

declare(strict_types=1);

require __DIR__ . '/private/lib.php';

if (!is_host()) redirect_to('host.php');

// Random state, checked by callback.php, so nobody can trick the host's browser into
// connecting someone else's Spotify account.
$state = bin2hex(random_bytes(16));
set_cookie('jb_oauth', $state, 600);

redirect_to(SPOTIFY_ACCOUNTS . '/authorize?' . http_build_query([
    'response_type' => 'code',
    'client_id' => SPOTIFY_CLIENT_ID,
    'scope' => SCOPES,
    'redirect_uri' => redirect_uri(),
    'state' => $state,
]));
