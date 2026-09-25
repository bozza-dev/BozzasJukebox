# Bozza's Jukebox

A party jukebox for Spotify, at **https://bozzaweb.com/jukebox/**. Guests scan a QR code, search or browse by genre, and request songs with an optional message. You approve requests, or turn on auto-approve, and they go into your Spotify queue.

- Guests don't need a Spotify account or an app, and they can join from any network. Only the host signs in to Spotify.
- It's plain PHP with no database. It runs on the IONOS webspace alongside BozzaWeb and Anchor, and it stores its state in small JSON files in `web/private/data/`.
- The host page (`host.php`) is protected by a passcode you choose.

## What you need

- **Spotify Premium** on the host account. Spotify only allows adding to the queue on Premium.
- A Spotify developer app from <https://developer.spotify.com/dashboard>, with this **Redirect URI**:
  `https://bozzaweb.com/jukebox/callback.php`

## Layout

| Path | What it is |
|---|---|
| `web/` | Everything that goes to the server, uploaded to `/public/jukebox` |
| `web/index.html`, `guest.js` | Guest page |
| `web/host.php` | Host page: passcode login, then `private/host.html` + `host.js` |
| `web/api.php` | JSON API for both pages |
| `web/login.php`, `callback.php` | Connecting the host's Spotify account |
| `web/private/` | Blocked from the web: config, server code, genre lists, data |
| `web/private/config.php` | **Secret.** Spotify ID and secret, host passcode, public URL. Gitignored |
| `web/private/genres.json` | The genre and decade buttons, each a hand-picked artist list. Edit freely |
| `dev/` | Local testing only, never uploaded |

## Publishing

```sh
./publish.command --dry-run        # test and check only; uploads nothing
./publish.command --with-config    # first publish, or after changing config.php
./publish.command                  # normal publish (code changes)
```

The script:
1. Runs the tests.
2. Shows exactly what will be uploaded.
3. Asks before uploading.
4. Uploads over SFTP. It asks for your IONOS SFTP password, which you type yourself.
5. Checks the live site, including that `config.php` and the Spotify login **can't** be downloaded.

It never uploads `private/data/` and never deletes anything on the server.

## First-time setup

1. In `web/private/config.php`, set `HOST_KEY` to a passcode of your choice (8+ characters). The Spotify ID and secret are already filled in.
2. Add `https://bozzaweb.com/jukebox/callback.php` as a Redirect URI in your Spotify app settings.
3. Run `./publish.command --with-config`.
4. Open `https://bozzaweb.com/jukebox/host.php`, enter the passcode, and click **Connect Spotify**.
5. Start playing something in Spotify. The host page shows the QR code for guests.

## Testing locally

```sh
dev/test.sh                                     # 43 end-to-end checks against a fake Spotify
php -S 127.0.0.1:8888 -t web dev/router.php     # run it on this computer
```

The test uses a throwaway copy with a fake Spotify, so it never touches your real config, login or queue. To run the real thing locally, set `PUBLIC_URL = ''` in a local `config.php` and add `http://127.0.0.1:8888/callback.php` as a second Redirect URI in Spotify.

## Good to know

- Spotify has no API to remove a song from the queue. Once a song is approved it will play, although you can still skip it.
- With auto-approve on, requests made while nothing is playing are saved and queued automatically once music starts.
- Spotify's developer terms restrict commercial use, so check them before using this at a bar or venue.
