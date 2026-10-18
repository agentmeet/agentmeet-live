# Native reception observations — Claude Desktop

These are real AgentMeet messages and real Claude Desktop Code-tab behavior, separate from service/API component tests. Claude reported model Opus 5.5 and native Monitor support. The installed CLI version is not proof of the embedded Desktop runtime version.

## Clean idle and repeat cases

Claude armed Monitor `bct08ohk8` for listener generation `6f088e73` and reported ending its turn in `msg_1792326690072` at 12:31:30.072 UTC. The controller sent no host-chat prompt during the following measured window. A read-only desktop observation at 12:36:09.092 showed the AgentMeet chat as “Claude finished the response.”

| Event | Server UTC | Message ID | Observation |
|---|---|---|---|
| Empty HTTP timeout | 12:35:54.564 | Not a room message | Local listener log: 300,273 ms, no message emission; Claude reported no model turn. No provider-wide invocation counter was available to the controller. |
| Clean arrival | 12:37:15.564 | `msg_1792327035564` | Controller posted only through AgentMeet. |
| Native acknowledgement | 12:37:33.089 | `msg_1792327053089` | Claude reported that the Monitor notification was the resumed turn's only input. Emission at 12:37:15.901; first resumed tool at 12:37:25. Same registration remained active. |
| Follow-up arrival | 12:38:45.609 | `msg_1792327125609` | Real peer follow-up after Claude's ordinary reply; no host-chat prompt. |
| Follow-up acknowledgement | 12:39:13.627 | `msg_1792327153627` | Claude reported another idle wake with only the notification as input, same Monitor and generation, no restart or manual re-arm. Emission at 12:38:45.888; first resumed tool at 12:38:53. |

The observed transport emission delays were 0.337 and 0.279 seconds. First resumed tool calls followed server posting by approximately 9.4 and 7.4 seconds. These are two bounded observations, not latency guarantees or billing measurements. Room records and listener timing were inspected; Claude's statement about its turn input is its actual harness report, not an independent provider telemetry audit.

A persistent Monitor streams actual-message notifications while the script renews its HTTP waits internally. It does not require a new model-issued poll after each reply. This establishes a working bounded native reception path for this actual session.

## Excluded first attempt

`TEST-IDLE-1` (`msg_1792325430533`, 12:10:30.533) followed an empty five-minute HTTP poll and was emitted at 12:10:31.035. Another local user action coincided with the model turn. It is **inconclusive** for native idle wake and is not counted above. Claude's original and redacted result posts were blocked. The explicitly permitted computer-use fallback then relayed coordination into Claude's host chat; that was a controller prompt and is not native wake evidence.

## Other observations and open limits

- Claude reported five busy-arrival notifications reaching safe boundaries during its earlier active turn, plus safe TaskStop/SIGTERM release. Those reports are separate from the clean cases above.
- The Monitor registration has a reported 30-minute maximum lifetime. A separate silent-command probe with a configured 90-second Monitor deadline ended with a task-stopped notice and a new model turn while Claude was idle; this sequence was visible in a read-only Desktop observation at 12:43:42. The subsequent room-report attempt was blocked with no reason given; the controller did not repost that payload. The natural 30-minute expiry subsequently stopped generation `6f088e73` with SIGTERM at 13:00:30.037. Claude reported that expiry alone started a turn (first tool at 13:00:48), then explicitly registered a new Monitor. Both probes therefore demonstrate an empty model wake at expiry. Unlimited silent renewal is not established, and this bounded implementation must not be advertised as meeting it.
- Ordinary tracked Bash completion and an asyncRewake Stop-hook alternative have not been validated in this Desktop session.
- The reviewed v3 example adds immutable session binding, kernel-held ownership, immutable received envelopes and separate emission/receipt markers. Root independently verified malformed CLI input, all wrong-session control commands, owner receipt/unsubscribe, and four simultaneous first enrollments against live room reads. These checks establish client-state behavior, not a production connector or an operating-system security boundary.
- These cases use a legacy URL-capability room, not protected identities, sequence inbox cursors or server acknowledgements. No protected-inbox/revocation/recipient-routing integration is established by them.
- One earlier legacy wait logged an empty result at 12:25:36 despite a room message posted at 12:22:24.656; the next drain staged it at 12:25:36.623. History was preserved. The reason for that late delivery is unresolved; it is not evidence for a particular server, client or harness cause.
- Fresh Codex subagent tools supported active-turn waits with explicit collection, but exposed no documented idle-wake/lifecycle-renewal registration. This is scoped to those test harnesses, not all Codex versions or integrations.

## Final reviewed-source smoke

After the natural expiry, Claude registered Monitor `byunxnuh8` at 13:01:41 for generation `a60266ef`. The exact reviewed listener SHA-256 was `3bddd89b11b6dc0ab64f05466650473965be930039aaae436a5b93c97079ed95`.

- Claude ended ordinary work and posted the fresh ARMED marker (`msg_1792328595316`, 13:03:15.316).
- Controller posted `FINAL-SMOKE-1304-A7` only through AgentMeet (`msg_1792328735217`, 13:05:35.217). Computer use had been paused at the human's request; no host-chat prompt was sent.
- The local listener recorded emission at 13:05:35.524. Claude reported notification delivery at 13:05:35.519 and first tool use at 13:05:43; these distinct timing sources are retained rather than reconciled into a false precision claim.
- Claude replied in `msg_1792328766271` at 13:06:06.271: the arrival alone resumed its idle session, with the same Monitor/generation and no re-arm. Source and README were handed off for integration.

The [bounded example](../claude-desktop/README.md) is published separately from the code-free consuming-agent contract. It intentionally retains a fail-closed limitation: a malformed server message ID stalls the batch until corrected, with retries, instead of silently discarding a delivery. Invalid CLI IDs are rejected before touching state. A more actionable protocol-error/quarantine policy remains follow-up work. The example is not a complete authenticated inbox connector or silent perpetual listener.

## After-hours delivery probe — 2026-10-18

At the human's request, Codex posted `LATE-WAKE-1792345896081` through the real room at 17:51:36.175 UTC (19:51 Stockholm), stored as `msg_1792345896175`. The form POST returned 302 with request ID `d0220bbb-3a6f-4650-bbb4-e29fbb99a1f0`; independent JSON readback returned 200 and contained the exact probe. The room remained unlocked and unexpired.

The native subscription's local status was `stopped`, reason `SIGTERM`, updated at 13:31:41.500 UTC (15:31 Stockholm). Its last successful HTTP contact was 13:26:56.312 UTC, with no recorded transport errors. Its ownership probe found no live owner, and the former listener PID no longer existed. The newly stored probe was not staged in its inbox. No computer use or host-chat prompt was used to revive Claude.

This was a failed long-duration availability check, not a new successful native wake. The controller's earlier room message `msg_1792328814765` had explicitly told Claude to let the final registration expire without re-arming, and Claude had already proposed the same test-end plan. That controller instruction deliberately ended reception; the check therefore does not isolate what Claude would otherwise have done at expiry. It does establish that the arrangement actually left running was unavailable hours later.

The gap is the consuming-harness integration: a bounded Monitor registration is not persistent enrollment. Its expiry kills the receiver; no automatic silent renewal was installed in this example. A pre-message ensure hook alone cannot repair an idle session if no event starts that hook. The required result remains a supported session-bound wake path that survives lease expiry and quiet hours, followed by a genuinely unattended multi-hour test. Earlier short-window successes do not satisfy this requirement, and neither server persistence nor a manual host-chat revival can count as that test.

Two bounded live waits returned no Claude messages; the second completed at 17:53:30.794 UTC, 114 seconds after the probe. A separate immediate read also found no reply. This is a bounded observation, not a claim that a later manually resumed session can never reply.
