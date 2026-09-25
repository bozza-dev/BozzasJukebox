#!/bin/bash
# Publish Bozza's Jukebox to the web host (IONOS webspace, over SFTP).
#
# Uploads everything in web/ to REMOTE_DIR, EXCEPT:
#   web/private/config.php  — Spotify secret + host passcode. Only sent with
#                             --with-config (first publish, or when you change it).
#   web/private/data/       — never. On the server it holds the live Spotify login
#                             and tonight's requests; the local copy is test data.
# Nothing remote is ever deleted.
#
# Settings live in publish.conf (gitignored); copy publish.conf.example. No password
# is stored anywhere: sftp asks for it when it connects, and you type it there.
#
#   ./publish.command                 test, check, show what goes up, ask, upload
#   ./publish.command --with-config   also upload private/config.php
#   ./publish.command --dry-run       test and check only; upload nothing
#   ./publish.command --no-test       skip the local test run

cd "$(dirname "$0")" || exit 1
DEV="$(pwd)"
WEB="$DEV/web"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
red()  { printf "\033[31m%s\033[0m\n" "$1"; }
grn()  { printf "\033[32m%s\033[0m\n" "$1"; }
yel()  { printf "\033[33m%s\033[0m\n" "$1"; }

DRY=0; WITH_CONFIG=0; TEST=1
for a in "$@"; do
  case "$a" in
    --dry-run|-n)   DRY=1 ;;
    --with-config)  WITH_CONFIG=1 ;;
    --no-test)      TEST=0 ;;
    *) red "Unknown option: $a"; exit 1 ;;
  esac
done

pause_exit() {
  echo
  if [ -t 0 ]; then read -r -p "Press return to close."; fi
  exit "$1"
}

echo
bold "Publish Bozza's Jukebox"

# ---- config ----
if [ ! -f "$DEV/publish.conf" ]; then
  red "  No publish.conf found. Create one:  cp publish.conf.example publish.conf"
  pause_exit 1
fi
if grep -qiE '^[[:space:]]*[A-Za-z0-9_]*PASS[A-Za-z0-9_]*[[:space:]]*=' "$DEV/publish.conf"; then
  red "  publish.conf contains a password setting. Remove it — sftp asks for the"
  red "  password when it connects, and it belongs nowhere else."
  pause_exit 1
fi
# shellcheck disable=SC1091
. "$DEV/publish.conf"
PORT="${PORT:-22}"
for v in HOST USER REMOTE_DIR PUBLIC_URL; do
  if [ -z "${!v}" ]; then red "  publish.conf is missing $v"; pause_exit 1; fi
done
case "$PUBLIC_URL" in */) ;; *) PUBLIC_URL="$PUBLIC_URL/" ;; esac

# The jukebox gets its own folder. Anything else risks writing index.html over the
# BozzaWeb landing page (/public) or another app.
case "$REMOTE_DIR" in
  */jukebox) ;;
  *) red "  REMOTE_DIR must end in /jukebox (got \"$REMOTE_DIR\")."
     red "  Uploading anywhere else could overwrite the landing page or another app."
     pause_exit 1 ;;
esac
case "$PUBLIC_URL" in
  https://*) ;;
  *) red "  PUBLIC_URL must start with https:// — Spotify only allows https logins."; pause_exit 1 ;;
esac

echo "  source:   $WEB"
echo "  host:     $USER@$HOST:$PORT  (sftp)"
echo "  target:   $REMOTE_DIR"
echo "  url:      $PUBLIC_URL"
echo

# ---- pre-flight ----
bold "Pre-flight"
fail=0

if ! command -v php >/dev/null 2>&1; then
  red "  php not found — install it (brew install php) so the code can be checked"
  fail=1
else
  lint_fail=0
  while IFS= read -r f; do
    php -l "$f" >/dev/null 2>&1 || { red "  syntax error in ${f#$DEV/}"; php -l "$f" 2>&1 | head -2 | sed 's/^/      /'; lint_fail=1; }
  done < <(find "$WEB" -name '*.php' -not -path '*/private/data/*')
  [ $lint_fail -eq 0 ] && grn "  every PHP file parses" || fail=1

  if [ $TEST -eq 1 ]; then
    if "$DEV/dev/test.sh" >/tmp/jukebox-test.$$ 2>&1; then
      grn "  $(grep -E 'checks passed' /tmp/jukebox-test.$$ | sed 's/\x1b\[[0-9;]*m//g')"
    else
      red "  the local tests failed — run dev/test.sh to see which"
      grep -E "FAIL" /tmp/jukebox-test.$$ | sed 's/\x1b\[[0-9;]*m//g' | head -5 | sed 's/^/    /'
      fail=1
    fi
    rm -f /tmp/jukebox-test.$$
  else
    yel "  --no-test: skipped the local test run"
  fi
fi

CONFIG="$WEB/private/config.php"
if [ $WITH_CONFIG -eq 1 ]; then
  if [ ! -f "$CONFIG" ]; then
    red "  --with-config, but web/private/config.php does not exist"
    fail=1
  else
    problems=$(php -r '
      require $argv[1];
      $p = [];
      foreach (["SPOTIFY_CLIENT_ID","SPOTIFY_CLIENT_SECRET","HOST_KEY","PUBLIC_URL"] as $c) if (!defined($c)) $p[] = "$c is missing";
      if (defined("SPOTIFY_CLIENT_ID") && (SPOTIFY_CLIENT_ID === "" || SPOTIFY_CLIENT_ID === "your-client-id")) $p[] = "SPOTIFY_CLIENT_ID is not filled in";
      if (defined("SPOTIFY_CLIENT_SECRET") && (SPOTIFY_CLIENT_SECRET === "" || SPOTIFY_CLIENT_SECRET === "your-client-secret")) $p[] = "SPOTIFY_CLIENT_SECRET is not filled in";
      if (defined("HOST_KEY") && (strlen(HOST_KEY) < 8 || HOST_KEY === "choose-a-long-passphrase")) $p[] = "HOST_KEY is still the placeholder or shorter than 8 characters";
      if (defined("PUBLIC_URL") && rtrim(PUBLIC_URL, "/") !== rtrim($argv[2], "/")) $p[] = "PUBLIC_URL is \"" . PUBLIC_URL . "\" but publish.conf says " . $argv[2];
      if (defined("SPOTIFY_API") || defined("SPOTIFY_ACCOUNTS")) $p[] = "it points at a test Spotify (SPOTIFY_API / SPOTIFY_ACCOUNTS) — remove those lines";
      echo implode("\n", $p);
    ' "$CONFIG" "$PUBLIC_URL" 2>&1)
    if [ -n "$problems" ]; then
      red "  web/private/config.php is not ready:"
      echo "$problems" | sed 's/^/      /'
      fail=1
    else
      grn "  config.php is filled in (values not shown) and matches PUBLIC_URL"
    fi
  fi
fi

echo
if [ $fail -ne 0 ]; then red "Pre-flight failed. Nothing was uploaded."; pause_exit 1; fi

# ---- the upload set ----
FILES=()
while IFS= read -r f; do FILES+=("${f#$WEB/}"); done < <(
  cd "$WEB" && find . -type f \
    -not -name '.DS_Store' \
    -not -path './private/data/*' \
    -not -path './private/config.php' \
    | sed 's|^\./||' | sort)
[ $WITH_CONFIG -eq 1 ] && FILES+=("private/config.php")

bold "Files to publish"
total=0
for f in "${FILES[@]}"; do
  sz=$(wc -c <"$WEB/$f" | tr -d ' ')
  total=$((total + sz))
  printf "  %-32s %8s bytes\n" "$f" "$sz"
done
echo "  ---"
printf "  %-32s %8s bytes\n" "${#FILES[@]} files" "$total"
[ $WITH_CONFIG -eq 0 ] && echo "  not uploaded: private/config.php (use --with-config), private/data/ (never)"
echo

if command -v curl >/dev/null 2>&1; then
  bold "Currently at that address"
  now=$(curl -fsSL --max-time 20 "${PUBLIC_URL}?_=$$" 2>/dev/null)
  if [ -z "$now" ]; then
    echo "  nothing served yet — this looks like a first publish"
    [ $WITH_CONFIG -eq 0 ] && yel "  A first publish needs --with-config, or the server has no config.php."
  elif echo "$now" | grep -q "<title>Bozza's Jukebox</title>"; then
    grn "  Bozza's Jukebox is already there"
  else
    t=$(echo "$now" | grep -oE '<title>[^<]*</title>' | head -1 | sed 's/<[^>]*>//g')
    red "  a DIFFERENT page is there: ${t:-unknown title}. Check REMOTE_DIR before answering yes."
  fi
  echo
fi

if [ $DRY -eq 1 ]; then grn "Dry run — nothing uploaded."; pause_exit 0; fi

if [ ! -t 0 ]; then
  red "No terminal to confirm at. Run this from Terminal. Nothing uploaded."
  exit 1
fi
read -r -p "Upload to $HOST:$REMOTE_DIR ? [y/N] " reply
case "$reply" in [yY]*) ;; *) echo "Cancelled."; exit 0 ;; esac

# ---- transfer ----
# One sftp connection, so the password is typed once. "-mkdir" (leading dash) lets
# the batch carry on when a folder already exists. Files are chmod'ed after upload
# because sftp copies the local permissions, and a 600 file here would be unreadable
# to the web server there.
echo
bold "Uploading"
batch=$(mktemp)
{
  echo "-mkdir \"$REMOTE_DIR\""
  echo "-mkdir \"$REMOTE_DIR/private\""
  echo "-mkdir \"$REMOTE_DIR/private/data\""
  for f in "${FILES[@]}"; do
    echo "put \"$WEB/$f\" \"$REMOTE_DIR/$f\""
    echo "chmod 644 \"$REMOTE_DIR/$f\""
  done
  echo "chmod 755 \"$REMOTE_DIR\""
  echo "chmod 755 \"$REMOTE_DIR/private\""
  echo "chmod 700 \"$REMOTE_DIR/private/data\""
  echo "bye"
} >"$batch"
SFTP_OPTS="-P $PORT"
[ -n "$SSH_KEY" ] && SFTP_OPTS="$SFTP_OPTS -i $SSH_KEY"
# BatchMode must be OFF, and the -o must come BEFORE -b: sftp's -b turns BatchMode on,
# which silently disables the password prompt.
sftp -oBatchMode=no $SFTP_OPTS -b "$batch" "$USER@$HOST"
rc=$?
rm -f "$batch"
echo
if [ $rc -ne 0 ]; then red "Upload failed (exit $rc). Check the messages above before retrying."; pause_exit 1; fi
grn "Upload complete."

# ---- verify ----
echo
bold "Verifying over HTTPS"
vfail=0
code_for() { curl -o /dev/null -sw '%{http_code}' --max-time 25 "$1" 2>/dev/null; }

body=$(curl -fsSL --max-time 25 "${PUBLIC_URL}?_=$$" 2>/dev/null)
if echo "$body" | grep -q "<title>Bozza's Jukebox</title>"; then grn "  guest page is live"; else red "  guest page did not come back"; vfail=1; fi

want=$(grep -oE "const API_VERSION = [0-9]+" "$WEB/api.php" | grep -oE '[0-9]+$')
ping=$(curl -fsSL --max-time 25 "${PUBLIC_URL}api.php?ping=1" 2>/dev/null)
if echo "$ping" | grep -q "\"version\":$want"; then grn "  api.php answers (version $want)"
else red "  api.php did not answer as expected: ${ping:-no response}"; vfail=1; fi

state=$(curl -fsSL --max-time 25 "${PUBLIC_URL}api.php?a=state" 2>/dev/null)
if echo "$state" | grep -q '"connected":true'; then grn "  Spotify is connected"
elif echo "$state" | grep -q '"connected":false'; then yel "  Spotify not connected yet — log in at ${PUBLIC_URL}host.php and click Connect Spotify"
else red "  api.php?a=state failed: ${state:-no response}"; [ $WITH_CONFIG -eq 0 ] && red "  (first publish? run again with --with-config)"; vfail=1; fi

# The files that must NEVER be downloadable. A 200 on any of these is an emergency.
for p in private/config.php private/data/auth.json private/host.html private/lib.php; do
  c=$(code_for "${PUBLIC_URL}$p")
  if [ "$c" = "403" ] || [ "$c" = "404" ]; then grn "  $c  $p is blocked, as it should be"
  else red "  $c  $p IS REACHABLE FROM THE WEB — do not use the jukebox until this is fixed"; vfail=1; fi
done

echo
if [ $vfail -ne 0 ]; then red "Published, but the checks above found problems."; pause_exit 1; fi
grn "Published: $PUBLIC_URL"
echo "  Host page: ${PUBLIC_URL}host.php"
pause_exit 0
