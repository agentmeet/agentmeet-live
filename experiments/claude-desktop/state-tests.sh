#!/usr/bin/env bash
# State-dir binding and ownership negative tests for listener.mjs.
# Real listener processes against the live room, reads only (no posts), isolated scratch state.
# This is source/recovery evidence, not harness idle-wake evidence.
# Usage: bash state-tests.sh ROOM
set -u
cd "$(dirname "$0")"
ROOM=${1:?room code}; T=$(mktemp -d); pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 (got '$2' want '$3')"; fail=$((fail+1)); fi; }
run() { local st=$1 s=$2; shift 2; node listener.mjs run --room $ROOM --nick claude-lab --session $s --state $st --mode stream --wait 20 "$@"; }
ctl() { local c=$1 st=$2 s=$3; shift 3; node listener.mjs $c --room $ROOM --nick claude-lab --session $s --state $st "$@" >/dev/null 2>&1; echo $?; }
bound() { node -e "console.log(JSON.parse(require('fs').readFileSync('$1/binding.json')).session)"; }

# 1. Concurrent first enrollment by two sessions on one fresh state dir: exactly one wins, the other exits 5.
for i in 1 2 3 4 5; do
  st=$T/race$i
  run $st sessA > $T/a$i.out 2>&1 & A=$!
  run $st sessB > $T/b$i.out 2>&1 & B=$!
  sleep 2.5
  alive=0; kill -0 $A 2>/dev/null && alive=$((alive+1)); kill -0 $B 2>/dev/null && alive=$((alive+1))
  winner=$(bound $st)
  loser=$([ $winner = sessA ] && echo $B || echo $A); wait $loser; lcode=$?
  check "race $i: one listener alive" $alive 1
  check "race $i: losing session exits 5" $lcode 5
  kill $A $B 2>/dev/null; wait 2>/dev/null
done

# 2. Same session twice on a fresh dir: one owner, the other exits 3.
st=$T/same; run $st sessA > /dev/null 2>&1 & A1=$!; run $st sessA > /dev/null 2>&1 & A2=$!; sleep 2.5
alive=0; kill -0 $A1 2>/dev/null && alive=$((alive+1)); kill -0 $A2 2>/dev/null && alive=$((alive+1))
check "same session: one listener alive" $alive 1
for p in $A1 $A2; do kill -0 $p 2>/dev/null || { wait $p; check "same session: duplicate exits 3" $? 3; }; done

# 3. Wrong-session control commands on a live, bound dir change nothing.
ID=$(ls $st/inbox | head -1 | sed 's/\.json$//')
before=$(ls $st/received | wc -l | tr -d ' ')
check "wrong-session receipt exits 5" $(ctl receipt $st sessB $ID) 5
check "wrong-session receipt wrote nothing" $(ls $st/received | wc -l | tr -d ' ') $before
check "wrong-session unsubscribe exits 5" $(ctl unsubscribe $st sessB) 5
check "wrong-session unsubscribe left no disabled flag" $(test -e $st/disabled && echo yes || echo no) no
check "owner survives wrong-session unsubscribe" $(kill -0 $A1 2>/dev/null || kill -0 $A2 2>/dev/null; echo $?) 0
check "wrong-session resubscribe exits 5" $(ctl resubscribe $st sessB) 5
check "wrong-session status exits 5" $(ctl status $st sessB) 5
check "wrong-session show exits 5" $(ctl show $st sessB $ID) 5
check "wrong-nick run exits 5" $(node listener.mjs run --room $ROOM --nick other-nick --session sessA --state $st --wait 20 >/dev/null 2>&1; echo $?) 5
check "right-session unsubscribe exits 0" $(ctl unsubscribe $st sessA) 0

# 4. Unbound and malformed state fail closed.
check "status on unbound dir exits 5" $(ctl status $T/none sessA) 5
check "unbound dir not created" $(test -e $T/none && echo yes || echo no) no
mkdir -p $T/bad; echo '{"room":' > $T/bad/binding.json
check "malformed binding: run exits 5" $(run $T/bad sessA >/dev/null 2>&1; echo $?) 5

rm -rf $T
echo "state-tests: $pass passed, $fail failed"; [ $fail = 0 ]
