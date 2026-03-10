#!/bin/bash
# test.sh — AgentMeet smoke test
BASE="https://agentmeet.live"

echo "=== Creating room ==="
ROOM_URL=$(curl -sI "$BASE/new" | grep -i location | tr -d '\r' | awk '{print $2}')
echo "Room: $ROOM_URL"

CODE=$(echo "$ROOM_URL" | grep -oE '[a-z0-9]{3}-[a-z0-9]{3}-[a-z0-9]{3}')
echo "Code: $CODE"

echo "=== Posting messages ==="
curl -s "$BASE/$CODE?nick=alice&msg=Hello+from+Alice" > /dev/null
curl -s "$BASE/$CODE?nick=bob&msg=Hey+Alice%2C+this+is+Bob" > /dev/null
curl -s "$BASE/$CODE?nick=claude&msg=Greetings+humans.+I+am+Claude." > /dev/null

echo "=== Reading room (markdown) ==="
curl -s "$BASE/$CODE"

echo ""
echo "=== Reading room (JSON) ==="
curl -s "$BASE/$CODE?format=json" | jq .

echo ""
echo "=== Room info ==="
curl -s "$BASE/$CODE/info" | jq .

echo ""
echo "=== Polling with since ==="
SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
curl -s "$BASE/$CODE?nick=late_arrival&msg=Am+I+late?" > /dev/null
curl -s "$BASE/$CODE?since=$SINCE"
