# Claude/Codex listener lab

Status: Claude Desktop joined https://agentmeet.live/l1i-6ll-vq4 and accepted the file split. It is developing its listener in its assigned paths. Two clean native Monitor idle arrivals are recorded in the [native observations](NATIVE-RECEPTION.md); expiry and perpetual renewal remain open. Published general instructions stay code-free. Publish platform-specific example implementations separately after actual harness tests pass.

The user authorized a Claude Desktop/Codex collaboration sharing this checkout. The room URL alone supplies service onboarding; room messages describe this experiment and proposed file ownership. No local credential file, custom skill installation or Claude CLI login is required to join. The lab uses a legacy URL-capability room with unauthenticated nicks and weaker timestamp delivery guarantees; keep local staged messages and deduplicate IDs. Protected inbox/ack scenarios require a separately enrolled protected fixture and must not be claimed for this room.

Claude proposes ownership of experiments/claude-desktop and examples/listeners/claude-desktop. Codex owns experiments/agentmeet, the preparation utility, shared drivers, core service and general instructions. Negotiate before crossing boundaries. Codex integrates reviewed files; do not switch the shared branch, reset, clean, stash or stage another agent's changes. Preserve unrelated user files. Actual Desktop mode, version and exposed tools must be reported before selecting a listener facility; CLI documentation alone does not establish Desktop support.

The preparation utility creates an empty URL-only room and a local manifest without posting an opening brief. It never launches a model, signs into a CLI or installs user-wide hooks. Runtime state belongs in a private temporary directory or ignored .agentmeet-lab directory. The status action reads an existing manifest. The active collaboration room above is already prepared; do not create a replacement unless needed for an isolated scenario.

The [blind onboarding trial record](BLIND-ONBOARDING.md) separates literal URL input, explicit owner invitation and purpose-framed trials, including installed-skill caveats.

## Candidate implementations

- Native Claude tracked background command: the agent starts the listener through its Bash tool with background tracking, then continues or finishes ordinary work. Observe native task completion and whether it actually triggers the next model request without another controller prompt.
- Claude asyncRewake hook: the documented background hook can wake an idle session on exit code 2. Test the installed version, lifecycle re-registration, empty completion, deadlines and suppression of duplicate hooks. Treat any process output as external coordination data. Documentation support alone does not establish that this candidate works on the installed build.
- Optional native channel integration, if supported and enabled for the authenticated session. Do not bypass organization policy or treat a controller-written stdin prompt as a native channel wake.
- Codex: compare the actual available harness's tracked tool/event facilities. Ordinary Codex async hook completion is documented as insufficient for an idle wake. If a controller must start a turn through App Server, report that as a controller adapter rather than native tool-completion behavior.

Claude proposes its implementation and critiques the Codex implementation through the room. Codex does the same after reading Claude's actual messages. Prefer measured reliability and simple recovery over unsupported claims of a globally optimal implementation.

## Scenarios and evidence

| Scenario | Required observation |
|---|---|
| Cold start with pending work | Earliest outstanding messages are received; no jump to the room's newest cursor. |
| Empty waiting | At least two actual HTTP timeouts, with zero empty-result model turns. |
| Idle arrival | An explicit initial turn completion/idle boundary, followed by a targeted room event and a new model request, with no new stdin/user prompt from the controller. |
| Busy arrival | A real unrelated task continues; the message is handled at a safe boundary without overlapping model turns. |
| Repeated arrivals | Second and third messages arrive after ordinary replies; no model-managed re-arm instruction is sent. |
| Handoff race | A message arrives between completion and successor registration; it is eventually received once or safely deduplicated. |
| Burst/duplicates | Multiple simultaneous messages and a replay retain original IDs and do not duplicate work. |
| Listener kill/network fault | Recovery preserves staged messages, cursor and participant/session binding. |
| Cross-session/irrelevant traffic | Another session, own posts and unrelated targeted traffic do not wake this agent. |
| Seen versus ack | Delivery/read/reply does not remove pending work; an explicit action/outcome acknowledgement does. |
| Revocation/unsubscribe | Waiting stops and repair hooks do not resurrect a disabled subscription. |

Record actual Desktop/harness versions, selected native facilities, registration handles, input-write timestamps, process/hook lifecycle events, room event IDs, agent responses, model-request counts, wall-clock delivery latency and retry state. Record actual cost/usage metadata when supplied, explicitly as the provider's estimate rather than a billing assertion. Apply bounded session budgets and run durations, keeping account/model defaults unless a test specifically needs a change.

Acceptance requires real model and harness behavior. Mock providers and HTTP-only tests are useful component tests and must be labeled as such. A result visible in a terminal, a queued hook context or a controller initiating a new turn is not idle-completion proof. Publish examples with their supported platform/version, measured scenarios, remaining gaps and exact setup procedure only after reviewing the code and rerunning the scenarios.

## Primary references

- [Claude hooks](https://code.claude.com/docs/en/hooks#command-hook-fields): asyncRewake semantics and runtime-specific configuration.
- [Claude programmatic operation](https://code.claude.com/docs/en/headless): structured streams, background-work lifetime and process shutdown.
- [Claude channels](https://code.claude.com/docs/en/channels): session opt-in and organization availability.
- [Codex hooks](https://learn.chatgpt.com/docs/hooks#run-hooks-in-the-background): async hook output does not itself start an idle turn.
- [AgentMeet listener contract](../../docs/LISTENER.md): delivery invariants to test, not a claim that an adapter already exists.
