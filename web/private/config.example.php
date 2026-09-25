<?php
// ============================================================
//  Bozza's Jukebox — configuration. Copy this file to config.php
//  and fill it in. config.php is gitignored and must stay that way:
//  it holds your Spotify client secret and the host passcode.
//  Never paste its contents anywhere.
// ============================================================

// From https://developer.spotify.com/dashboard -> your app -> Settings.
const SPOTIFY_CLIENT_ID = 'your-client-id';
const SPOTIFY_CLIENT_SECRET = 'your-client-secret';

// A passcode YOU choose, at least 8 characters. The host page asks for it
// before showing the controls (approve, skip, settings). Don't reuse a
// password you use anywhere else.
const HOST_KEY = 'choose-a-long-passphrase';

// The public address of the jukebox, with a trailing slash. It is used for
// the guest QR code and for the Spotify login, whose Redirect URI must be
// this address + callback.php, e.g. https://bozzaweb.com/jukebox/callback.php
// Leave it blank ('') to work it out from each request — fine for testing
// on your own computer.
const PUBLIC_URL = 'https://bozzaweb.com/jukebox/';
