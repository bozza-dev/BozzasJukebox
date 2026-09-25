# Jukebox

A party jukebox for Spotify. Guests scan a QR code, search for songs on their phones and tap **Request**. You approve the requests (or turn on auto-approve), and the songs go into your Spotify queue on whatever device is playing.

- Guests don't need a Spotify account or an app. Only the host signs in.
- It has no dependencies. It's plain Node (20.6 or newer) and runs on your laptop.
- Guests can browse by genre or decade. Each category is a hand-picked artist list in the `GENRES` list in `server.js`, so you can edit it.
- The **Queue** tab shows what's coming up, highlights the guest's own songs and gives each one's position ("#3 in queue").
- Guest requests have limits (waiting requests per guest, a cooldown and duplicate blocking), and you can block explicit songs.

## What you need

- **Spotify Premium** on the host account. Spotify only allows adding to the queue on Premium.
- Node 20.6 or newer.
- Guests on the same Wi-Fi as the computer running the jukebox.

## One-time setup

1. Go to <https://developer.spotify.com/dashboard> and create an app.
   - **Redirect URI:** `http://127.0.0.1:8888/callback`
   - **APIs used:** Web API
2. Open the app's **Settings** and copy the Client ID and Client Secret.
3. In this folder:
   ```sh
   cp .env.example .env
   # paste the Client ID and Client Secret into .env
   ```

## Running a party

```sh
npm start
```

The terminal prints two links:

- **Host page:** `http://127.0.0.1:8888/host?key=…` Open it on the same computer and click **Connect Spotify**. You only do this once, because the login is remembered. Keep this link private.
- **Guest link:** `http://192.168.x.x:8888`. The host page shows it as a QR code, which you can put on a screen or print.

Then **start playing something in Spotify** on the speaker, phone or computer you want to use. Spotify needs an active device before it will accept queued songs.

## Host controls

| Setting | What it does |
|---|---|
| Auto-approve | Requests go straight into the Spotify queue. |
| Allow explicit songs | When off, guests can't request explicit tracks. |
| Pause requests | Guests can still browse, but they can't request. |
| Max waiting per guest | Limits how many unapproved requests each guest can have (default 3). |
| Cooldown | Sets the minimum time between one guest's requests (default 60s). |

The host page also has **Skip**, which moves to the next track, and **Approve all**.

## Good to know

- Spotify has no API to remove a song from the queue. Once a song is approved, it will play, although you can still skip it.
- Requests are kept in memory, so restarting the server clears them. The Spotify login, host key and settings are saved in `.jukebox-data.json`. That file is gitignored and contains your Spotify refresh token, so don't share it.
- New Spotify developer apps start in development mode. That's fine here because only you log in. Spotify's developer terms also restrict commercial use, so check them before using this at a bar or venue.
- Guests on a different network: set `PUBLIC_URL` in `.env` to a tunnel or deployed URL so the QR code points to it.
