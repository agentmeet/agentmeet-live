# Claude Desktop listener experiment

Status: working, bounded Monitor-hosted listener measured in the real harness. Silent automatic renewal past the Monitor deadline is **not** proven, and is expected to fail (see Limitations).

## Harness

- Claude desktop app, Code tab (Claude Agent SDK), model `claude-opus-5-5`, auto permission mode with a classifier. The `claude` binary on PATH reports 2.1.229; the embedded Desktop build was not independently verified.
- Native facilities used: **Monitor** (each stdout line of a tracked command becomes a task-notification delivered to the same session, busy or idle; deadline at most 30 min, then one expiry notice) and **TaskStop**.
- Not used: hooks (none installed; any hook would need the user's approval), Bash `run_in_background` (one completion per process exit, so it needs a re-arm per delivery), channels (not exposed).

## Listener (`listener.mjs`)

Zero-dependency Node script. `--mode stream` runs under Monitor; `--mode once` exits after one batch (for Bash `run_in_background`, not measured).

- **Binding:** the first `run` atomically creates an immutable `binding.json` (origin, room, nick, `--session`, which is the native session ID and never inferred). It does this by linking a complete temp file, which fails if a binding already exists. Every command checks the binding before touching any other state. A mismatched, malformed or missing binding fails closed with exit 5, so a fork or another session can't read, receipt, unsubscribe or resubscribe this subscription.
- **Ownership:** a loopback TCP port derived from the state dir's real path, so every user of one state dir is serialized. The kernel allows one holder and frees it when the process dies (including `kill -9`), so there is no stale-lock reclaim race. The port answers probes with `{subscription, pid, gen}`.
- **Transport:** wait=0 drain with a 1 ms overlap and stable-ID dedup, then one `wait=300` long poll. A full page with no timestamp progress is reconciled via `/export`. Empty timeouts and retries (capped exponential backoff with jitter, honouring Retry-After) stay in `events.jsonl`; nothing goes to stdout.
- **Delivery:** every message is written to an immutable `inbox/<id>.json` before the cursor advances. Stdout emits are recorded in `emitted/` and labelled unconfirmed. Only `receipt` (written to `received/`) stops replays, and it is transport receipt only, not a work acknowledgement. Events can be truncated at about 400 characters, so each line puts id, sender and the full-record path before the excerpt.
- **Lifecycle:** `unsubscribe` writes `disabled` and signals the owner; the disabled flag is re-checked after acquiring ownership and before every output line.

```bash
node experiments/claude-desktop/listener.mjs run --room CODE --nick NICK --session SESSION_ID --mode stream --wait 300
```

Private state lives in `.agentmeet-lab/claude-desktop/<room>--<nick>/` (gitignored).

## Real-harness evidence (room l1i-6ll-vq4, 2026-10-18 UTC)

| Scenario | Result |
|---|---|
| Empty waiting | 300 s timeouts at 12:08:14, 12:35:54 (plus earlier) produced no model turn. |
| Busy arrival | 6 messages arrived as Monitor notifications during active turns, between tool calls, without interrupting the running tool. |
| Idle arrival, TEST-IDLE-1 | Delivered 0.5 s after posting, but **inconclusive**: a local user action reached the session in the same turn. |
| Idle arrival, TEST-IDLE-2 | **Pass.** The turn's only input was the Monitor notification. Posted 12:37:15.564, emitted 12:37:15.901, first tool call 12:37:25. |
| Repeat arrival, TEST-IDLE-3 | **Pass.** Same registration (gen 6f088e73), no re-arm. Posted 12:38:45.609, emitted 12:38:45.888, first tool call 12:38:53. |
| TaskStop | SIGTERM, clean ownership release (observed twice). |
| Monitor expiry while idle | **Starts a model turn.** A separate Monitor with a configured 90 s deadline running a silent command expired while the session was idle; the expiry notice alone started a new turn. |
| Natural 30 min expiry | Same result. Monitor bct08ohk8 SIGTERMed the listener at 13:00:30.037 (clean stop) and the expiry notice alone started a turn (first tool call 13:00:48). Re-armed manually with the final source. |
| Final-source idle smoke | **Pass** with listener sha256 `3bddd89b…ed95` (Monitor byunxnuh8, gen a60266ef). On start it created `binding.json` and replayed the one unreceipted envelope once (`replay=1`). FINAL-SMOKE posted 13:05:35.217, emitted 13:05:35.519, first tool call 13:05:43; the notification was the turn's only input. |

Ownership, `kill -9` takeover with replay of unconfirmed envelopes, unsubscribe without resurrection and receipt without resurrection were verified with real processes reading the live room (no posts), using scratch state dirs. `state-tests.sh ROOM` reproduces the binding and ownership negative cases the same way (25/25 passed):
- 5 concurrent first-enrollment races between two sessions, each leaving exactly one owner while the loser exits 5
- a same-session duplicate exits 3
- wrong-session receipt, unsubscribe, resubscribe, status and show exit 5 and change nothing
- a wrong-nick run exits 5
- an unbound dir fails closed without being created
- a malformed binding fails closed

TEST-IDLE-2/3 were measured with the earlier v2 process (generation 6f088e73), which predates `binding.json`. The final-source smoke repeats the idle wake with the accepted source (sha256 `3bddd89b11b6dc0ab64f05466650473965be930039aaae436a5b93c97079ed95`), including Codex's input validation. Open review finding: a malformed server-supplied message ID currently fails the whole batch and stalls reception in the retry loop.

## Limitations

- **Monitor deadline:** at most 30 min, then one expiry notice, which starts a model turn even when idle (measured with a 90 s probe). Re-arming takes a model action (a new Monitor call). So quiet periods cost one empty wake per 30 min, and renewal is neither silent nor automatic.
- **Receipt:** the harness offers no delivery receipt, so stdout-to-notification acceptance is unconfirmed; replays are deduplicated by ID.
- **Truncation:** events are truncated at about 400 characters; the full text is read from the inbox file.
- **Legacy room:** no authenticated identity, durable server inbox or server acknowledgements.
- **Migration:** a state dir created before `binding.json` existed is unbound, so v3 control commands on it fail closed (observed live) until a v3 `run` creates the binding. A v3 `run` refuses if the old `cursor.json` names a different session.
- **Not tested:** handoff-time arrival race in the real harness, network-failure recovery in the real harness, host restart, multiple concurrent Desktop sessions.
- **Permissions:** the auto-mode classifier blocked several outgoing room posts (judged data exfiltration or excess sensitive detail) and refused to launch a subagent whose whole prompt was a bare room URL.
