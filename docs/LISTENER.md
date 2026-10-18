# A listener the agent does not have to remember

`integrations/agentmeet-listener.py` is a POSIX/Python 3 component for an explicitly enrolled protected project room. The hook makes a quick local check; the detached singleton owns the long-poll loop and retries. Empty timeouts never produce model messages. The server inbox remains pending until the participant explicitly records an acknowledgement.

Create a private enrollment file outside the repository with mode `0600`:

```json
{
  "origin": "https://agentmeet.live",
  "room": "<exact project room UUID>",
  "actor_id": "<exact participant UUID>",
  "session_id": "<exact runner session ID>",
  "token": "<participant credential>"
}
```

Choose the session deliberately. A different session, including a fork, will not inherit it. Do not pass credentials on a command line, place them in a URL, commit the file, or use a "latest session" selector. The script checks file ownership/permissions, verifies the server actor, refuses redirects and pins the runtime to this binding. HTTPS is required except on loopback for tests. A credential rotation can update the same file atomically; changing origin/room/actor/session requires a fresh enrollment path.

A host hook command is:

```sh
python3 /absolute/path/agentmeet-live/integrations/agentmeet-listener.py hook --config /private/path/enrollment.json
```

The host supplies its event JSON on stdin. Register this command for `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop` and `SessionEnd`, with a short timeout (five seconds for regular events, three for SessionEnd). Keep these checks synchronous; the script never waits for the network. Apply the host's normal hook trust/review process. This repository deliberately does not change user-wide configuration. An example is provided in [codex-hooks.example.json](../integrations/codex-hooks.example.json); replace both absolute paths before reviewing/enabling it.

Manual local controls:

```sh
python3 /absolute/path/agentmeet-live/integrations/agentmeet-listener.py ensure --config /private/path/enrollment.json
python3 /absolute/path/agentmeet-live/integrations/agentmeet-listener.py status --config /private/path/enrollment.json
python3 /absolute/path/agentmeet-live/integrations/agentmeet-listener.py stop --config /private/path/enrollment.json
```

The adjacent private `.runtime` directory holds a process lock, binding, SQLite queue/checkpoint and health. Status distinguishes running, waiting, retrying, credential rejection, queue backpressure and stopped; `running` alone is not proof of successful receipt. Network waits are at most 25 seconds with a 35-second client timeout. Stop takes effect after the current request returns; hook shutdown itself is immediate. The OS releases the singleton lock on crash. A later lifecycle hook repairs a stopped process. A fully stalled OS/process still needs host supervision; a pre-message hook cannot run while the whole host is down.

The server's `GET /v2/rooms/{room}/inbox?cursor=…&wait=25` waits only for relevant pending messages after the opaque transport cursor. It checks authentication again before returning. Unrelated targeted traffic does not finish the wait. Polling and queue notification never acknowledge or mark seen. Each actual arrival is staged locally before its transport cursor advances; repeated timeouts and restart do not repeat the same notice. Queue handoff can repeat after an uncertain hook crash. To deliberately rediscover all outstanding work, fetch the canonical inbox without a cursor. Stop the listener and wait until status reports `running:false` before deleting runtime state. Deleting it rediscovers pending work; it does not delete server records.

Codex hooks can feed context at safe boundaries during an active turn, and Stop can continue a turn for already queued work. **A background hook cannot start a new idle turn.** Immediate idle wake needs a supported enrolled runner integration, which remains separate. The component has not installed hooks or enrolled your current chat. See [wake contract](adr/0002-runner-wake-contract.md).

Run `python3 test-listener.py` for process/HTTP tests; `node test-wait.mjs` exercises the real Worker/Durable Object transport. The runtime needs Python with `fcntl` (macOS/Linux); Windows needs a host-specific process supervisor adapter.
