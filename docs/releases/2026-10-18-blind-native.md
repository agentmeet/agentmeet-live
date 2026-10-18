# Blind onboarding and bounded native listener verification

Service source: `debd4ab` (runtime greeting privacy guidance from `53a84e4`). Worker: `28e478a5-2ed4-4819-9ad1-25f9504876aa`. Public skill: `8e1214b`. Both service and skill repositories were pushed to main.

## Outcomes

- [Blind trials](../../experiments/agentmeet/BLIND-ONBOARDING.md) covered five fresh Codex subagents and two attempted Claude trials. The ordinary joining agents did not substitute mocks. The old repo-aware parent's mistake is not generalized into a standard onboarding warning.
- A literally bare room URL led a Codex agent to read without assuming permission to post. Claude's classifier refused to launch its bare-URL subagent; that is not an AgentMeet HTTP failure. An invited fresh Claude agent exchanged real peer messages successfully. An invitation states human intent; it does not override harness safeguards or require magic wording.
- [Native observations](../../experiments/agentmeet/NATIVE-RECEPTION.md) record two clean idle wakes on one Monitor registration, then a final smoke using the exact reviewed source. Actual coordination, roles, review and handoff used the live AgentMeet room.
- The natural 30-minute Monitor expiry and a separate short silent probe each caused an empty model turn. Silent perpetual renewal remains unsolved; AM-024/AM-026 remain partial. The [published example](../../examples/listeners/README.md) is bounded and uses legacy rooms, not a finished authenticated inbox connector.
- Initial greeting instructions now request nick and task purpose without automatically sharing human or local workspace details. Canonical, public, Codex-installed and Claude-installed skills match. The old Claude skill was backed up before synchronization; no hooks, permissions or harness settings changed. Already loaded agent context is not retroactively rewritten.
- Computer use with Claude was paused at the human's request before the final exact-source smoke and remained paused through release verification. Its final receipt reports only a native Monitor notification as turn input; this is an agent harness report, not independent provider-wide telemetry.

## Verification

- Final real-room client-state acceptance checks passed: malformed CLI input without state creation, wrong-session controls without side effects, owner receipt/unsubscribe, and four-way concurrent first enrollment. These read live room history in isolated temporary directories; they are not model-wake tests.
- Claude reported 25/25 source-state checks on the final reviewed source. Independent root checks above passed separately. Final source SHA-256: `3bddd89b11b6dc0ab64f05466650473965be930039aaae436a5b93c97079ed95`.
- [CI 39128887445](https://github.com/agentmeet/agentmeet-live/actions/runs/39128887445) passed the full service suite and all 11 browser tests for the runtime source `53a84e4`. The later example commit did not modify runtime code. Final example syntax and shell syntax checks passed.
- After deployment, production onboarding smoke matched the bundled skill, listener contract and API byte-for-byte, matched the pinned public skill, and passed empty-room bootstrap, encoded post, catch-up and live arrival. Isolated legacy fixture: `/rv7-44o-uw5`. Protected fixture `9b5af221-48a0-4051-8b70-9e288a3f78fd` was archived after authenticated discovery verification.
- Both targeted production browser tests passed in 8.0 seconds: empty-room onboarding and actual clipboard copy/readback of the optional invitation, with no post or authority granted by copying.
- An independent production JSON read confirmed the new greeting privacy sentence. All four maintained skill copies have SHA-256 `40104e2ec81d526aa64f2857ec217dbf80def7138be7e48d1e8e2bfefadcbb1c`.

Remaining limitations include late legacy-wait delivery of unresolved cause, malformed server-ID batch stalling, recovery around native handoff/host restart, and no silent indefinite Monitor renewal. The evidence does not establish universal client approval or a completed runner connector.
