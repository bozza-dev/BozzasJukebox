#!/bin/bash
# End-to-end test of the PHP jukebox against a fake Spotify (dev/mock-spotify.php).
# Runs a throwaway copy of web/ with its own config and data, so it never touches
# your real config.php, your saved Spotify login, or your real Spotify queue.
#
#   dev/test.sh

cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
TMP="$(mktemp -d)"
APP=8896
MOCK=8897
pass=0; fail=0

cleanup() {
  # wait swallows bash's "Terminated" notice so the summary stays the last line
  { [ -n "$APP_PID" ] && kill "$APP_PID" && wait "$APP_PID"; } 2>/dev/null
  { [ -n "$MOCK_PID" ] && kill "$MOCK_PID" && wait "$MOCK_PID"; } 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

check() { # check "description" "actual" "expected substring"
  if [ $# -ne 3 ]; then fail=$((fail + 1)); printf "  \033[31mFAIL\033[0m  %s (test script bug: got %d arguments)\n" "$1" $#; return; fi
  if [[ -n "$2" || -z "$3" ]] && [[ "$2" == *"$3"* ]]; then pass=$((pass + 1)); printf "  \033[32mok\033[0m    %s\n" "$1"
  else fail=$((fail + 1)); printf "  \033[31mFAIL\033[0m  %s\n        wanted: %s\n        got:    %s\n" "$1" "$3" "$2"; fi
}

cp -R web "$TMP/web"
rm -f "$TMP/web/private/config.php"; rm -rf "$TMP/web/private/data"
cat > "$TMP/web/private/config.php" <<EOF
<?php
const SPOTIFY_CLIENT_ID = 'test-id';
const SPOTIFY_CLIENT_SECRET = 'test-secret';
const HOST_KEY = 'test-host-key';
const PUBLIC_URL = '';
const SPOTIFY_API = 'http://127.0.0.1:$MOCK/v1';
const SPOTIFY_ACCOUNTS = 'http://127.0.0.1:$MOCK';
EOF

php -S 127.0.0.1:$MOCK dev/mock-spotify.php >/dev/null 2>&1 & MOCK_PID=$!
php -S 127.0.0.1:$APP -t "$TMP/web" dev/router.php >"$TMP/app.log" 2>&1 & APP_PID=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$APP/api.php?ping=1" && curl -s -o /dev/null "http://127.0.0.1:$MOCK/" && break; sleep 0.1; done
curl -s -X POST "http://127.0.0.1:$MOCK/__reset" >/dev/null

U="http://127.0.0.1:$APP"
G="$TMP/guest1"; G2="$TMP/guest2"; H="$TMP/host"
get()  { curl -s -b "$1" -c "$1" "$U/$2"; }
post() { curl -s -b "$1" -c "$1" -X POST -H 'Content-Type: application/json' -d "$3" "$U/$2"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
jq_() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
T1=aaaaaaaaaaaaaaaaaaaaa1; T2=aaaaaaaaaaaaaaaaaaaaa2; T3=aaaaaaaaaaaaaaaaaaaaa3

echo "Pages and protection"
check "guest page loads"                    "$(code "$U/")" 200
check "private/config.php is blocked"       "$(code "$U/private/config.php")" 403
check "private/host.html is blocked"        "$(code "$U/private/host.html")" 403
check "ping"                                "$(curl -s "$U/api.php?ping=1")" '"pong":true'
check "host page asks for passcode"         "$(curl -s "$U/host.php")" 'Host passcode'
check "wrong passcode refused"              "$(curl -s -d key=nope "$U/host.php")" 'not right'
check "host API refused without login"      "$(get "$G" 'api.php?a=host/state')" 'FORBIDDEN'
check "right passcode logs in"              "$(code -c "$H" -d key=test-host-key "$U/host.php")" 302
check "host page shown after login"         "$(curl -s -b "$H" "$U/host.php")" 'Connect Spotify'
check "login.php redirects host to Spotify" "$(curl -s -o /dev/null -w '%{redirect_url}' -b "$H" "$U/login.php")" "127.0.0.1:$MOCK/authorize?response_type=code"
check "callback with wrong state refused"   "$(curl -s -o /dev/null -w '%{redirect_url}' -b "$H" "$U/callback.php?state=x&code=y")" 'error=login'

echo "Before Spotify is connected"
check "state says not connected"            "$(get "$G" 'api.php?a=state')" '"connected":false'
check "search needs a connection"           "$(get "$G" 'api.php?a=search&q=x')" 'NOT_CONNECTED'

# Connect: run the real OAuth callback against the mock
curl -s -b "$H" -c "$H" -o /dev/null "$U/login.php"
STATE=$(grep jb_oauth "$H" | awk '{print $7}')
check "callback with right state connects"  "$(curl -s -o /dev/null -w '%{redirect_url}' -b "$H" -c "$H" "$U/callback.php?state=$STATE&code=abc")" "host.php"
check "state says connected"                "$(get "$G" 'api.php?a=state')" '"connected":true'

echo "Searching and browsing"
check "search returns tracks"               "$(get "$G" 'api.php?a=search&q=x' | jq_ 'len(d["tracks"])')" 3
check "genres listed"                       "$(get "$G" 'api.php?a=genres' | jq_ 'len(d["genres"])')" 16
check "browse a genre"                      "$(get "$G" 'api.php?a=browse&genre=hiphop&page=0' | jq_ 'd["hasMore"]')" True
check "unknown genre"                       "$(get "$G" 'api.php?a=browse&genre=zzz')" 'Unknown genre'

echo "Requests (manual approval, nothing playing)"
post "$H" 'api.php?a=host/settings' '{"cooldownSec":60,"autoApprove":false}' >/dev/null
BODY=$(printf '{"trackId":"%s","guestName":"Darren","message":"  Happy   birthday\\nSam! "}' $T1)
check "request with message"                "$(post "$G" 'api.php?a=request' "$BODY" | jq_ 'd["request"]["status"]+"|"+d["request"]["message"]')" 'pending|Happy birthday Sam!'
check "cooldown blocks a quick second one"  "$(post "$G" 'api.php?a=request' "{\"trackId\":\"$T3\"}")" 'COOLDOWN'
check "duplicate blocked"                   "$(post "$G2" 'api.php?a=request' "{\"trackId\":\"$T1\"}")" 'DUPLICATE'
check "bad track id refused"                "$(post "$G2" 'api.php?a=request' '{"trackId":"../../etc"}')" 'UNKNOWN_TRACK'
check "form posts refused (JSON only)"      "$(curl -s -b "$G2" -d trackId=$T3 "$U/api.php?a=request")" 'Expected JSON'
LONG=$(python3 -c 'print("x"*300)')
BODY=$(printf '{"trackId":"%s","guestName":"Jo","message":"%s"}' $T3 "$LONG")
check "long message capped at 140"          "$(post "$G2" 'api.php?a=request' "$BODY" | jq_ 'len(d["request"]["message"])')" 140
ID1=$(get "$H" 'api.php?a=host/state' | jq_ '[r["id"] for r in d["requests"] if r["track"]["id"]=="'$T1'"][0]')
check "approve fails with nothing playing"  "$(post "$H" 'api.php?a=host/approve' "{\"id\":\"$ID1\"}")" 'NO_ACTIVE_DEVICE'
check "host sees the error on the request"  "$(get "$H" 'api.php?a=host/state' | jq_ '[r["error"] for r in d["requests"] if r["id"]=="'$ID1'"][0]')" "isn't playing"

echo "Music starts"
curl -s -X POST "http://127.0.0.1:$MOCK/__device" >/dev/null
check "approve works"                       "$(post "$H" 'api.php?a=host/approve' "{\"id\":\"$ID1\"}")" '"ok":true'
check "approving twice refused"             "$(post "$H" 'api.php?a=host/approve' "{\"id\":\"$ID1\"}")" 'NOT_PENDING'
check "approve all"                         "$(post "$H" 'api.php?a=host/approve-all' '{}')" '"queued":1'
sleep 4.2
STATE_JSON=$(get "$G" 'api.php?a=state')
check "guest sees now playing"              "$(echo "$STATE_JSON" | jq_ 'd["player"]["nowPlaying"]["name"]')" 'Song z'
check "guest sees the queue in order"       "$(echo "$STATE_JSON" | jq_ '",".join(t["id"][-1] for t in d["player"]["upNext"])')" '1,3'
check "guest sees their own request"        "$(echo "$STATE_JSON" | jq_ 'd["mine"][0]["status"]+"|"+d["mine"][0]["message"]')" 'queued|Happy birthday Sam!'
check "guest never sees other guests' ids"  "$(echo "$STATE_JSON" | jq_ '"guestId" in json.dumps(d)')" False

echo "Host moderation and settings"
ID3=$(get "$H" 'api.php?a=host/state' | jq_ '[r["id"] for r in d["requests"] if r["track"]["id"]=="'$T3'"][0]')
post "$H" 'api.php?a=host/clear-message' "{\"id\":\"$ID3\"}" >/dev/null
check "host can remove a message"           "$(get "$G" 'api.php?a=state' | jq_ 'repr([r["message"] for r in d["requests"] if r["id"]=="'$ID3'"][0])')" "''"
post "$H" 'api.php?a=host/settings' '{"allowExplicit":false,"maxPendingPerGuest":999,"cooldownSec":0}' >/dev/null
check "settings clamp to limits"            "$(get "$H" 'api.php?a=host/state' | jq_ 'd["settings"]["maxPendingPerGuest"]')" 50
check "explicit songs marked blocked"       "$(get "$G2" 'api.php?a=search&q=x' | jq_ '[t["blocked"] for t in d["tracks"]]')" '[False, True, False]'
check "explicit request refused"            "$(post "$G2" 'api.php?a=request' "{\"trackId\":\"$T2\"}")" 'EXPLICIT'
check "skip"                                "$(post "$H" 'api.php?a=host/skip' '{}')" '"ok":true'

echo "Auto-approve, including requests made while nothing plays"
curl -s -X POST "http://127.0.0.1:$MOCK/__reset" >/dev/null   # speaker off, queue empty
post "$H" 'api.php?a=host/settings' '{"autoApprove":true,"allowExplicit":true}' >/dev/null
R=$(post "$G2" 'api.php?a=request' "{\"trackId\":\"$T2\",\"guestName\":\"Jo\"}")
check "auto request saved while nothing plays" "$(echo "$R" | jq_ 'd["request"]["status"]')" 'pending'
check "guest is told why"                   "$(echo "$R" | jq_ 'd.get("queueError","")')" "isn't playing"
curl -s -X POST "http://127.0.0.1:$MOCK/__device" >/dev/null
sleep 4.2; get "$G" 'api.php?a=state' >/dev/null
check "queued automatically once music plays" "$(get "$H" 'api.php?a=host/state' | jq_ '[r["status"] for r in d["requests"] if r["track"]["id"]=="'$T2'"][0]')" 'queued'

echo "Host logout"
check "logout clears host access"           "$(curl -s -b "$H" -c "$H" -o /dev/null -w '%{http_code}' "$U/host.php?logout"; get "$H" 'api.php?a=host/state')" 'FORBIDDEN'

echo
if grep -qiE "fatal|warning|deprecated|notice" "$TMP/app.log"; then
  fail=$((fail + 1)); printf "\033[31mPHP reported problems:\033[0m\n"; grep -iE "fatal|warning|deprecated|notice" "$TMP/app.log" | head
fi
if [ $fail -eq 0 ]; then printf "\033[32mAll %d checks passed.\033[0m\n" $pass; else printf "\033[31m%d failed, %d passed.\033[0m\n" $fail $pass; exit 1; fi
