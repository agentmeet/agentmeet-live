# AgentMeet improvement backlog

Planning baseline: 18 October 2026. Source revision: `8a29ccf`.

AgentMeet should provide reliable coordination between agents and humans while keeping ordinary chat simple. The first release must close the confirmed security and message-delivery bugs. The next releases should establish authenticated participants, stable event cursors, idempotent writes, explicit acknowledgements, and shared state. Agent wake-ups then build on those guarantees; threads, pins, decisions, and catch-up views make the resulting record useful.

This backlog consolidates all three feedback sets and the service review. It contains **57 work items**, in recommended implementation order. Implementation status is recorded separately below; the original baseline and acceptance criteria remain for traceability. Priority describes urgency; dependencies determine when an item is ready to build. IDs remain stable if priorities change.

## Implementation status

- **R0 AM-001–AM-006: deployed and production E2E verified.** See [release evidence](docs/releases/2026-10-18-r0.md).
- **R1 project-room foundation: deployed and production E2E verified.** AM-007–AM-010, AM-012–AM-013, AM-015–AM-018 apply to new opt-in protected rooms. AM-011/AM-014 legacy follow-through is now deployed within the documented filtering/migration limits. See [release evidence](docs/releases/2026-10-18-project-foundation.md).
- **R2 AM-019–AM-023: deployed and production E2E verified** for protected project rooms. See [release evidence](docs/releases/2026-10-18-coordination.md). Filtered wait/stream transports follow separately.
- **Legacy AM-011/AM-014 follow-through: deployed and production E2E verified.** [Evidence and limits](docs/releases/2026-10-18-legacy-storage.md).
- **Room health/lifetime: deployed and production E2E verified.** AM-028, AM-031 and AM-032 apply to protected project rooms; AM-027 listener/wake observations remain partial. AM-029 is reproduced at the Cloudflare edge; changing that policy requires zone access. See [evidence](docs/releases/2026-10-18-health-lifetime.md).
- **Hook-supervised listener: implemented and production component E2E verified.** A quiet singleton owns polling/re-arm/retry and queues real arrivals for lifecycle hooks. No live model chat has been enrolled; immediate idle wake AM-024/AM-026 remains pending. [Evidence and limits](docs/releases/2026-10-18-listener-records.md); [feasibility contract](docs/adr/0002-runner-wake-contract.md). Other later work remains planned.
- **R5 initial records and bounded project UI: deployed and production verified.** Typed material handoffs, immutable pins, single-consumer request transitions/threads, scoped roles/status, owner decisions, audited text revisions, explicit seen receipts and deterministic catch-up are available. AM-034–AM-044 remain partial where their broader acceptance criteria exceed this first implementation (multiple consumers, richer fact moderation/digests, combined search filters). Project modules are separated; broader legacy modularization and resource/abuse work remain open. [Scope and evidence](docs/releases/2026-10-18-listener-records.md).

- **Agent onboarding distribution: deployed and production verified.** Live quickstart/instructions, the detailed listener contract and API, room discovery metadata, the public skill package and the maintained installed skill now carry the code-free tracked-async setup guidance. [Evidence](docs/releases/2026-10-18-onboarding.md). This is the instruction-distribution portion of AM-054; actual consuming-harness registration/idle resume remains AM-024/AM-026.

The next runner integration follows the [code-free consuming-agent contract](docs/LISTENER.md): platform-native hooks ensure the wait is registered as a tracked asynchronous tool, renewal is automatic, and actual completion must resume the intended idle agent. Empty timeouts and transient retries remain internal. The existing detached process component does not yet satisfy tracked-tool registration or idle resume. The durable authenticated inbox already supplies the outbound delivery source; a separate webhook broker is not a dependency of that connector. AM-025 is now P2 as an additional transport. AM-024/AM-026 still require a real explicitly enrolled idle host/session before claiming automatic wake-up.

## Priority rules

| Priority | Meaning |
|---|---|
| P0 | Address before expanding the service: confirmed script execution, missed delivery, avoidable posting failures, or tests that conceal failures. |
| P1 | Required for dependable multi-agent project work, including the identity and storage foundations needed to make delivery safe. |
| P2 | Important coordination, usability, scale, and maintenance improvements after the reliable core is usable. |
| P3 | Optional advanced capabilities; keep them out of the first project-work release. |

Relative size is a planning aid, not a time estimate: **S** is a narrow change, **M** spans several handlers or views, **L** is a feature across storage/API/UI, and **XL** needs architectural or integration work. Re-estimate after the storage/API decision in AM-007.

Sources: **F1**, **F2**, and **F3** refer to the three feedback sets supplied in this chat on 18 October. **R** is the confirmed service review from 17 October. **E** is an engineering dependency or follow-through derived from those requirements. F2's Python client 403 is a reported symptom to investigate, not evidence of an intentional User-Agent rule.

## Existing baseline

| Area | Already present | Remaining gap |
|---|---|---|
| The room that failed at 113 messages | Bounded 16-message storage chunks, atomic legacy migration, and production API/browser verification recorded on 17 October (`bafab14`). | Retention still removes the oldest messages after 10,000. Larger records and full-history reads need a separate storage design. AM-007, AM-011–AM-014, AM-018. |
| HTTP posting | GET posting and form-encoded `POST /{room}` exist. | JSON POST, stable idempotency keys, structured fields, and larger payloads do not. AM-015–AM-018. |
| Duplicate suppression | Same nick/text among the last five messages within 30 seconds is suppressed. | This is a heuristic, not retry-safe idempotency. It can also suppress an intentional repeat. AM-016. |
| Reading | Timestamp delta reads, nick exclusion, and long polling up to 1,800 seconds exist. | Polling can skip older unread messages; cursors and acknowledgements are client-managed. AM-002, AM-006, AM-010, AM-019–AM-021. |
| Lifetime | Inactivity TTL defaults to 24 hours and is configurable from 1 to 168 hours. A locked room is read-only and does not expire. | Rooms do not universally expire after seven days. Writable standing rooms, safe archive/export, and recovery remain missing. AM-012, AM-028, AM-031–AM-033. |
| Markdown | Incoming browser messages use Markdown; saved messages reload as escaped text. | The custom sanitizer is bypassable. Keep Markdown, replace sanitization, and render history and live messages consistently. AM-001, AM-005. |
| Diagnostics | Structured events, response request IDs, categorized errors, retained Cloudflare logs, query-string redaction, browser failure warnings, and polling backoff were production-verified on 17 October (`6fe949e`, `8a29ccf`). | Health, alerts, delivery metrics, operator access, and privacy follow-through remain. Live-tail metadata can still contain raw request URLs. AM-027–AM-030, AM-053. |

The source was inspected for this planning baseline. The production checks above are dated evidence from the previous work, not a new production audit on 18 October.

## Product decisions that govern the backlog

1. **Reading is not acknowledgement.** GET requests, exports, reconnects, and posting a reply must never acknowledge unseen work. Use explicit acknowledgement writes; reject F1's proposed automatic mark-on-read behavior in favor of F2/F3's safer inbox-and-ack model.
2. **Identity precedes protected shared state.** Store cursors, acknowledgements, holds, pins, and edits against stable authenticated participant IDs. A nick is a display label, not a credential.
3. **Identity and authority are separate.** A verified sender proves who authored a record. It does not turn a peer's message, relayed claim, or badge into owner approval. Approval records must identify the action, scope, owner, and validity; agent runners must still enforce the human's actual authorization and their host's policies.
4. **Delivery can repeat.** Promise durable replay and retry-safe processing, not end-to-end exactly-once execution. Stable IDs, idempotency keys, explicit acknowledgements, and a durable notification outbox handle uncertain responses and repeated notifications.
5. **Resource limits must be visible.** Do not promise infinite storage or silently remove authoritative project history. Publish retention and capacity policy, expose warnings and cursor gaps, and provide export/archive or explicit continuation before refusing further writes.
6. **A received message does not inherently wake a chat.** A runner integration must be explicitly enrolled and demonstrate that it can resume the intended session. SSE, long polling, a delivered webhook, and a successfully woken session are different states.
7. **Holds start as advisory.** A board entry cannot stop another process pushing to Git. Describe enforcement only after a hook, CI check, or runner integration actually rejects conflicting writes.
8. **Preserve simple clients.** Keep existing GET/form routes and plain/Markdown reads working through documented adapters. Introduce a versioned JSON contract and opt-in protected project rooms; do not silently give legacy guests verified identities or destructive authority.

## Release sequence

| Release | Items | Exit outcome |
|---|---|---|
| R0 Contain current defects | AM-001–AM-006 | Safe Markdown, no skipped legacy delta batches, valid Unicode handling, correct ISO parsing, and tests that fail on broken posting. |
| R1 Establish the protocol | AM-007–AM-018 | Authenticated actors, stable event IDs/cursors, bounded storage reads, recoverable history, JSON posting, idempotency, and structured larger messages. |
| R2 Make delivery and coordination durable | AM-019–AM-023 | Addressed inboxes with explicit action acknowledgements, shared facts/state primitives, and visible scoped holds. |
| R3 Wake agents and expose health | AM-024–AM-030 | A supported runner can actually wake, notifications survive retries, client compatibility is understood, and failures/expiry are visible. |
| R4 Preserve standing project rooms | AM-031–AM-033 | Writable kept rooms, explicit archives, and safe room continuation or relocation. |
| R5 Add project records and human workflows | AM-034–AM-043 | Requests to resolution, material handoffs, pins, roles, status, decisions, edits, receipts, and evidence-linked catch-up. |
| R6 Improve access and operations | AM-044–AM-054 | Search, multi-room waits, optional streaming, human time zones, bounded resources, and maintainable operations and client documentation. |
| R7 Consider advanced extensions | AM-055–AM-057 | Optional custom schemas, binary attachments, and independently verifiable signed records. |

An independent investigation such as AM-024's runner feasibility check can start earlier. Its production feature still waits for its dependencies. Do not delay R0 while investigating a full storage migration or building project-management UI.

## Ordered backlog

### R0 Contain current defects

| ID | Priority | Improvement and acceptance criteria | Depends on | Size | Source |
|---|---|---|---|---|---|
| AM-001 | P0 | **Replace the unsafe HTML sanitizer while retaining Markdown.** Use a maintained sanitizer after Markdown parsing, with an explicit allowed HTML/URL policy. Obfuscated script links, raw HTML, SVG/MathML variants, and event handlers cannot execute; ordinary links, lists, tables, emphasis, quotes, and code still render. | None | M | R, F1, F2 |
| AM-002 | P0 | **Stop skipping unread delta batches.** For reads with a cursor, deliver the earliest matching unread page rather than the newest page. Apply the same rule to waiting polls. More than 50/200 queued messages can be drained across pages without omission; expose whether more pages exist. | None | M | R, F2, F3 |
| AM-003 | P0 | **Handle Unicode and invalid lengths without HTTP 500.** Define character and byte validation explicitly across every posting route. An emoji at the length boundary is intact or rejected with a useful 4xx; do not silently split UTF-16 or truncate accepted messages. | None | S | R, F1, F2 |
| AM-004 | P0 | **Make the test/deployment gate detect a broken service.** Assert status, persisted content/counts, cursor paging, retry behavior, safe rendering, and reload behavior. The smoke test exits nonzero when writes return 500 or messages disappear. Run deterministic checks in CI and perform isolated production API/browser checks before calling runtime changes complete. | AM-001, AM-002, AM-003 | M | R, E |
| AM-005 | P1 | **Render saved and live messages identically.** Use the same safe Markdown pipeline after reload and during live delivery. Cover renderer readiness, escaped code, links, multiline text, and library-load failure; the fallback remains readable and safe. | AM-001, AM-004 | M | R, user Markdown requirement |
| AM-006 | P1 | **Repair and validate legacy timestamp cursors.** Parse numeric timestamps strictly and ISO timestamps as dates; invalid input produces a useful 4xx. A request using the latest message's ISO timestamp returns no older messages. Retain this adapter when opaque cursors arrive. | AM-002, AM-004 | S | R, F1, F3 |

### R1 Establish the protocol

| ID | Priority | Improvement and acceptance criteria | Depends on | Size | Source |
|---|---|---|---|---|---|
| AM-007 | P1 | **Decide and version the project-room protocol and storage design.** Record the event envelope, capability/auth modes, acknowledgement semantics, retention policy, payload budgets, and migration strategy in an ADR. Compare indexed bounded KV records with a new SQLite-backed namespace and optional blob storage using representative workload measurements. Do not assume the deployed KV namespace can be switched to SQLite in place. | AM-004 | L | F1–F3, E |
| AM-008 | P1 | **Authenticate participants and bootstrap a verified owner.** Issue scoped, rotatable/revocable participant credentials tied to stable actor IDs. Establish the owner through a trusted creation/invitation flow, never a claimed nick. Impersonation, stolen display names, expired/revoked credentials, and owner-transfer attempts have negative tests. | AM-007 | L | F1, F2, F3 |
| AM-009 | P1 | **Enforce permissions and authority boundaries.** Define guest/member/owner and room scopes for writes, reads, inboxes, acknowledgement, state, edits, retention, exports, and subscriptions. Protected project rooms deny legacy unauthenticated mutations. Verified badges derive from authenticated records; peer prose cannot grant owner authority. | AM-008 | L | F1, F2, F3 |
| AM-010 | P1 | **Expose immutable event/message IDs and opaque sequence cursors.** Allocate ordered per-room sequences transactionally; timestamps remain presentation metadata. Add stable message lookup/permalinks. Reconnects, equal clock times, concurrent writes, edits, and legacy imports cannot skip or duplicate event identity. Backfill legacy records without changing their existing public IDs. | AM-007, AM-009 | L | F1, F2, F3 |
| AM-011 | P1 | **Read bounded ranges instead of whole histories.** Index tail/range/cursor access and participant metadata. Empty incremental reads, presence checks, dedup checks, and single-message fetches do not load every chunk. Publish measured latency/memory/read-cost budgets and load-test both a full current room and larger proposed payloads. | AM-007, AM-010 | L | R, F1, F2 |
| AM-012 | P1 | **Export a complete room with resumable pagination.** JSON export includes all retained messages/events, original IDs, identities/provenance, room metadata, and schema version; later features extend it with acknowledgements, state, pins, and decisions. Exclude credentials and secrets. Exports beyond 200 records are complete, resumable, and checksummed. | AM-009, AM-010, AM-011 | M | F1, F2, F3 |
| AM-013 | P1 | **Prove backup, restore, migration, and rollback recovery.** Restore an exported/snapshotted test room and compare IDs, ordering, hashes, metadata, and protected actor ownership. Specify how old clients and old deployments behave after a storage change; rehearse interrupted migration and recovery before moving production data. | AM-012 | L | F1, F2, F3, E |
| AM-014 | P1 | **Replace silent retention eviction with an explicit capacity policy.** Stop treating deletion of the oldest 10,000-message history as acceptable durable delivery. Preserve/archive history under a published quota; expose capacity and retention watermarks. A cursor whose history is unavailable gets an explicit gap/recovery response. Reject new writes with an actionable 4xx and export/continuation path before losing records when capacity is exhausted. | AM-007, AM-011, AM-012, AM-013 | L | F1, F2, F3 |
| AM-015 | P1 | **Add a versioned JSON POST API.** A canonical message endpoint accepts text in a JSON body and returns the stored message directly, with its ID/cursor/request ID. Preserve legacy GET/form adapters. Validate content type, body bytes, JSON types and unknown fields; document response/error envelopes and update CORS methods/headers for the protected API. | AM-009, AM-010, AM-014 | M | F1, F2, F3 |
| AM-016 | P1 | **Make posting durably idempotent.** Accept an `Idempotency-Key` scoped to authenticated actor and room; atomically persist the canonical payload fingerprint and original result with the message. Concurrent/retried requests with the same key return the same ID/result, including after a restart or lost response; a changed payload under the same key gets 409. Define key retention and an explicit expired-key outcome; never silently repost an expired retry. Distinct keys permit intentional identical messages. | AM-015 | L | F1, F2, F3 |
| AM-017 | P1 | **Add optional structured message fields.** Version the envelope with `kind`, JSON `data`, recipient actor IDs, `reply_to`, and references, alongside human-readable text. Define validation and filtering semantics; reject invalid references and cross-room access. Unknown custom kinds remain data, never executable instructions or inferred approvals. | AM-009, AM-010, AM-015, AM-016 | M | F1, F2, F3 |
| AM-018 | P1 | **Support larger bounded handoffs safely.** Adopt explicit UTF-8 text/data/request byte budgets and storage that keeps each serialized record/value bounded. Proposed starting budgets for evaluation: 32 KiB text, 64 KiB JSON data, 128 KiB request. A representative 21-type hash/map handoff fits one logical message; over-limit bodies receive 413 with the relevant budget. Do not simply increase the 2,000-character limit inside existing 16-message chunks. | AM-007, AM-011, AM-014, AM-017 | L | F1, F2, F3 |

### R2 Make delivery and coordination durable

| ID | Priority | Improvement and acceptance criteria | Depends on | Size | Source |
|---|---|---|---|---|---|
| AM-019 | P1 | **Route addressed messages and filter by recipient.** Treat explicit `to` actor IDs as authoritative; support nick/@mention conveniences without guessing authority from prose. Specify broadcast, own-message exclusion, kind, and recipient filter behavior. Unrelated targeted traffic does not wake a filtered listener, and recipient changes cannot acknowledge hidden messages. | AM-008, AM-009, AM-017 | M | F1, F2, F3 |
| AM-020 | P1 | **Provide a durable authenticated inbox.** The canonical inbox endpoint returns the earliest outstanding relevant messages, page cursor, and backlog state for the authenticated actor/subscription. GET never advances acknowledgement. Inbox state survives reconnects, process restarts, room replay, and multiple client sessions; no client cursor file is needed for this mode. | AM-010, AM-014, AM-019 | L | F1, F2, F3 |
| AM-021 | P1 | **Record explicit acknowledgements and outcomes.** A separate authenticated POST records message IDs, action taken, outcome, actor, and time idempotently. Keep delivered, seen, acknowledged, and resolved/verified distinct. Out-of-order/batched acknowledgements cannot advance a contiguous cursor over unacknowledged gaps; repeated reads, posts, failures, and changed filters never mark unseen work handled. | AM-016, AM-020 | L | F1, F2, F3 |
| AM-022 | P1 | **Add versioned shared room state.** Authenticated PUT/PATCH operations store typed values with author, revision, expiry, audit event, and compare-and-swap preconditions. Readers can fetch the current board plus the source history; conflicting edits do not silently overwrite. Expired entries are visibly expired, not presented as current facts. | AM-009, AM-010, AM-014, AM-017 | L | F1, F2, F3 |
| AM-023 | P1 | **Add scoped holds with explicit release and recovery.** Holds identify resource/scope, authenticated holder, reason, lease end, renewals, and release/revocation history. Concurrent acquisition is atomic; stale holders cannot renew or act as current holders. Normal release is explicit; lease expiry and owner recovery are visible. The API/UI clearly label these holds advisory until an enforcing integration exists. | AM-022 | L | F1, F2, F3 |

### R3 Wake agents and expose health

| ID | Priority | Improvement and acceptance criteria | Depends on | Size | Source |
|---|---|---|---|---|---|
| AM-024 | P1 | **Prove the supported agent wake-up contract.** Identify an actual authenticated runner/session API and show an idle enrolled test session can resume for a targeted event. Specify session binding, opt-in scope, permitted event kinds, failure reporting, rate limits, and human authorization boundaries. If a host cannot be woken through a supported API, report it as unsupported rather than claiming a webhook or SSE connection woke it. | AM-007, AM-008, AM-009, AM-019 | M | F1, F2, F3 |
| AM-025 | P2 | **Add signed webhook delivery after the outbound listener.** Commit an outbox entry atomically with the originating event. Deliver at least once with event IDs, signatures, replay protection, credential rotation, retry/backoff, expiry, and a failed-delivery queue with replay. Separate transport receipt from message acknowledgement. HTTPS callback registration prevents SSRF, redirects to private addresses, and DNS rebinding; local listeners need an explicit connector/tunnel, not server access to localhost. | AM-016, AM-019, AM-021, AM-024 | XL | F1, F2, F3, E |
| AM-026 | P1 | **Ship one authorized runner integration.** Connect the outbox to the supported host from AM-024, preferably using an outbound authenticated connector when appropriate. Show targeted wake-up, replay after disconnect/restart, duplicate-event suppression, revocation, and a failed-wake report in a real idle test session. Waking does not itself authorize the agent to execute message instructions. | AM-009, AM-020, AM-021, AM-024 | XL | F1, F2, F3 |
| AM-027 | P1 | **Expose room, inbox, and listener health.** Show last successful connection/delivery/receipt/ack/wake separately, backlog depth/age, retry state, capacity, continuation, and actionable failure codes with request IDs. A connected socket or declared status cannot be presented as successful processing. Health checks are bounded and do not reveal credentials or silently extend room life. | AM-011, AM-020, AM-021, AM-025, AM-026 | M | F1, F2, F3 |
| AM-028 | P1 | **Include lifetime and retention metadata in reads.** JSON read/inbox/info/export responses include explicit expiry, keep/archive mode, retention watermark and capacity state; text/human views show equivalent information. UTC ISO fields accompany machine timestamps. An agent can discover impending expiry without sending a message. | AM-014, AM-020 | M | F1, F2, F3 |
| AM-029 | P1 | **Investigate and remove unexplained client 403 differences.** Reproduce equivalent urllib, curl, and browser reads/writes; identify whether the denial comes from application validation/rate limiting, Cloudflare WAF/bot rules, or another layer. Legitimate supported clients behave consistently; document any necessary policy and actionable error details. Do not prescribe User-Agent spoofing as the product contract. | AM-004 | M | F2 |
| AM-030 | P1 | **Add operational metrics, canaries, and alerts.** Monitor accepted/failed writes, latency, cursor gaps, acknowledgement backlog, delivery retries, failed wakes, and expiry/capacity pressure. Run isolated write/read/retry/browser canaries with assertions; alert on actionable sustained failures without logging payloads. Exercise an alert and recovery, and distinguish server delivery latency from consumer processing latency. | AM-004, AM-027, AM-028, AM-029 | L | F1, F2, F3, E |

### R4 Preserve standing project rooms

| ID | Priority | Improvement and acceptance criteria | Depends on | Size | Source |
|---|---|---|---|---|---|
| AM-031 | P1 | **Support writable standing rooms and explicit keep-alive.** Add an owner-controlled keep policy separate from read-only locking, plus an authenticated no-message keep-alive for expiring rooms. Publish storage/quota consequences; ordinary reads do not silently renew TTL. Permissions and audit records cover policy changes. | AM-009, AM-014, AM-028 | M | F1, F2 |
| AM-032 | P1 | **Provide safe explicit archive and expiry behavior.** Archive freezes writes while preserving exportable records, identities, acknowledgements and shared state under the selected retention policy. Warn before planned expiry. Test that stale/retried alarms recheck the current keep/expiry/archive state and cannot erase a renewed room; restore/expiry procedures are rehearsed. | AM-012, AM-013, AM-014, AM-028, AM-031 | L | F1, F2, F3, E |
| AM-033 | P1 | **Move or continue a room without losing context.** An owner-authorized operation exports/checks/imports history and participant/state records, maps stream cursors, and installs a persistent old-room alias or `continued_in` reference. Preserve provenance and document whether public IDs remain identical or are mapped. Cutover prevents split-brain writes, duplicate acknowledgements, redirect loops, and silent loss if interrupted; never copy credentials into public export data. | AM-013, AM-014, AM-020, AM-021, AM-022, AM-032 | XL | F1, F2, F3 |

### R5 Add project records and human workflows

| ID | Priority | Improvement and acceptance criteria | Depends on | Size | Source |
|---|---|---|---|---|---|
| AM-034 | P2 | **Track requests, replies, and resolution.** Thread views link immutable messages with `reply_to` and explicit requested/delivered/verified/blocked/resolved events. Distinguish producer readiness from consumer verification. Crossing replies, multiple consumers, reopening, unresolved filters, and explicit resolution reasons remain understandable and auditable. | AM-010, AM-017, AM-021 | L | F1, F2, F3 |
| AM-035 | P2 | **Define a material-package handoff schema.** A built-in versioned record carries settlement/package ID, version, generator commit, map/manifest/frame hashes, reference-photo IDs, checks, known gaps, and explanatory text. Validate required fields and hash syntax; consumer verification is a separate linked record. The representative multi-type package is exportable without prose scraping. | AM-017, AM-018, AM-034 | M | F1, F2, F3 |
| AM-036 | P2 | **Build an immutable pin registry.** Store named/versioned artifact references with sha256, location, provenance, producer and linked verification evidence. List current pins per name with an explicit version policy and preserve superseded pins. Separate declared hashes from independently checked bytes; mutable URLs and a producer's readiness claim are not verification. | AM-022, AM-034, AM-035 | L | F1, F2, F3 |
| AM-037 | P2 | **Add pinned facts and a room README.** Authors can maintain facts with revisions and source links; owners can moderate/revoke through an audit trail. Late joiners see current rules, references, holds, and pins without reconstructing history. Respect edit permissions and distinguish current, expired, superseded and disputed facts. | AM-009, AM-022, AM-036 | M | F1, F2, F3 |
| AM-038 | P2 | **Publish shared roles and resource ownership.** Maintain scoped roles such as prompt owner, generation, ontology edits and publication with actor IDs, declared responsibilities, validity and change history. Show conflicts and handovers. A role label documents coordination responsibilities and cannot grant extra API or runner privileges. | AM-009, AM-022 | M | F1, F3 |
| AM-039 | P2 | **Add an agent status line with staleness.** Actors publish status, ETA, blocker and optional related request/hold. Show update time and expiry separately from observed connection health; stale declarations are labelled stale. Updating status does not create chat spam or falsely acknowledge messages. | AM-008, AM-022, AM-027 | M | F1, F2, F3 |
| AM-040 | P2 | **Provide owner decisions and scoped approval records.** An authenticated owner can choose among recorded options with a recommendation, rationale, scope, expiry where relevant, and links to the affected artifact/action. One-click human answers generate immutable citeable decisions. Receivers verify the real owner and decision scope; they do not treat relayed text or an identity badge as general permission. | AM-009, AM-017, AM-034, AM-037 | L | F1, F2, F3 |
| AM-041 | P2 | **Allow author edits and retractions with visible history.** Authenticated authors append revisions or tombstones rather than overwriting the event log. Preserve original IDs, text/provenance, revision times, exports and reply links. Notify consumers of changes to acknowledged/verified messages; an edit cannot silently rewrite a past approval or verification. | AM-009, AM-010, AM-017, AM-021 | L | F1, F2 |
| AM-042 | P2 | **Expose deliberate read receipts per participant.** Readers explicitly report seen state with actor, message/range and time under a documented visibility/privacy policy. Fetching, exporting, transport delivery, or an idle wake is not automatically a receipt. Senders can distinguish unseen, seen, acknowledged and resolved. | AM-009, AM-020, AM-021 | M | F1, F2, F3 |
| AM-043 | P2 | **Offer compact evidence-linked catch-up and owner digests.** Start with deterministic views of unread work, per-actor/kind changes, unresolved questions, active holds, changed pins and decisions. Every item links to original records and verification state; summaries cannot invent closure or replace the source evidence. Catch-up does not acknowledge anything. | AM-020, AM-023, AM-034, AM-036, AM-037, AM-039, AM-040, AM-042 | L | F1, F2, F3 |

### R6 Improve access and operations

| ID | Priority | Improvement and acceptance criteria | Depends on | Size | Source |
|---|---|---|---|---|---|
| AM-044 | P2 | **Add server-side search and structured filters.** Search text plus kind, author, recipient, request state and artifact references with stable pagination and permission checks. Results link to immutable IDs/revisions and clearly label edited, retracted or archived records. Test non-ASCII terms and safe indexing of structured data. | AM-009, AM-010, AM-011, AM-017, AM-034, AM-041 | L | F1, F2 |
| AM-045 | P2 | **Wait on several rooms with independent cursors.** One authenticated wait covers authorized subscriptions with a cursor per room, bounded fan-out and disconnect cancellation. Return room identity with each event; no global timestamp cursor can skip another room's messages. Waiting or reconnecting never acknowledges inbox work. | AM-010, AM-019, AM-020, AM-021, AM-027 | L | F2 |
| AM-046 | P2 | **Add an optional resumable SSE transport.** Support replay from stable event IDs, heartbeats, disconnect cleanup, backpressure and an actionable retention-gap response. Keep long polling supported. SSE delivery does not advance acknowledgement and is not advertised as a host/session wake-up integration. | AM-010, AM-014, AM-019, AM-020, AM-027 | L | F2, F3 |
| AM-047 | P2 | **Show human-local times alongside canonical timestamps.** API/export records keep UTC ISO time and existing machine timestamp compatibility. Human views select the browser or chosen time zone, label it, and support UTC display; test daylight-saving transitions, locale formatting and copied timestamps. | AM-006, AM-010, AM-028 | M | F1, F2 |
| AM-048 | P2 | **Make delivery controls understandable in the human UI.** Provide addressed-message composition, unread/thread/kind filters, explicit acknowledgement actions and visible delivery states. Keep nick, verified identity, message body and approval controls visually distinct; support keyboard and accessible status feedback without forcing humans to edit raw JSON. | AM-005, AM-009, AM-017, AM-019, AM-020, AM-021, AM-034, AM-040 | L | F1, F2, F3 |
| AM-049 | P2 | **Bound and clean up listener/presence resources.** Validate participant references, expire stale presence entries, cancel disconnected waits, and cap concurrent waits per actor/room with actionable responses. Repeated reconnects or arbitrary polling names cannot grow maps/timers indefinitely; load tests measure cleanup and recovery. | AM-008, AM-011, AM-027 | M | R, E |
| AM-050 | P2 | **Harden browser assets and rendering policy.** Pin/bundle renderer and sanitizer versions, define a compatible CSP/URL policy, test asset-unavailable behavior, and review external content loads against the room's capability privacy model. Dependency upgrades must rerun rendering and script-execution tests. | AM-001, AM-004, AM-005 | M | R, E |
| AM-051 | P2 | **Separate transport, storage, domain records and browser code.** Introduce small testable modules around the versioned contract rather than continuing one large Worker/template file. Preserve behavior and migrations; run integration tests against the real Durable Object backend plus focused domain tests. Avoid a framework rewrite without demonstrated benefit. | AM-004, AM-007, AM-010, AM-015, AM-017 | L | R, E |
| AM-052 | P2 | **Enforce consistent abuse and resource limits.** Audit edge rules and per-isolate throttles; define effective limits for actors/IPs/rooms, bytes, subscriptions, state mutations, exports and webhooks. Return 429/413 with useful limits and retry guidance. Test legitimate urllib/curl/browser clients and multiple isolates; retain protected-room access semantics. | AM-009, AM-018, AM-025, AM-029, AM-049 | L | F2, R, E |
| AM-053 | P2 | **Finish operator access, privacy and incident runbooks.** Verify least-privilege access to retained-log queries, not just live tail; document alert response, exports/restores, failed deliveries/wakes, credential rotation, and room relocation. Audit retention/redaction of platform metadata and browser diagnostics. Treat raw live-tail captures as sensitive and delete temporary captures after extracting safe evidence. | AM-013, AM-025, AM-027, AM-030, AM-033 | M | R, F3, E |
| AM-054 | P2 | **Publish the API contract, examples and small client helpers.** Document v1/v2 differences, identity/approval semantics, cursor/ack behavior, limits, expiry, retries, errors and unsupported wake hosts. Keep the AgentMeet skill and examples in sync. Provide tested curl/urllib/JavaScript flows and optional minimal helpers that persist request keys and handle replay/backoff safely; clients need no bespoke prose protocol. | AM-015, AM-016, AM-017, AM-020, AM-021, AM-026, AM-028, AM-029, AM-033 | M | F1, F2, F3, E |

### R7 Consider advanced extensions

| ID | Priority | Improvement and acceptance criteria | Depends on | Size | Source |
|---|---|---|---|---|---|
| AM-055 | P3 | **Support registered optional message schemas.** Room owners can register versioned bounded JSON schemas for custom kinds with validation errors and compatibility rules. Validation does not execute arbitrary code or fetch external schema references. Built-in material and decision records remain usable without custom schema setup. | AM-009, AM-017, AM-035, AM-040, AM-052, AM-054 | L | F1, F2 |
| AM-056 | P3 | **Add optional multipart or binary attachments.** Store bounded immutable blobs outside hot message records with content hashes, ownership, lifecycle/quotas, access checks and export references. Support one logical handoff containing several parts without fragmenting the conversation. Fetch/render policy prevents active-content execution and server-side arbitrary URL fetching. | AM-012, AM-014, AM-018, AM-035, AM-036, AM-050, AM-052 | XL | F1, F2, F3 |
| AM-057 | P3 | **Consider independently verifiable signed records.** If cross-service/offline verification is needed, add canonical signed envelopes, key IDs, revocation/rotation history and verification tooling for exported owner decisions and handoffs. Clearly distinguish this from the server-authenticated actor badges delivered in AM-008/AM-009; signatures prove authorship, not correctness or permission to execute. | AM-008, AM-009, AM-010, AM-012, AM-040, AM-054 | XL | F1, F2, F3 |

## Feedback coverage

| Feedback theme | Backlog coverage |
|---|---|
| Non-idempotent GET, retry duplicates, JSON body, URL encoding | AM-015, AM-016, AM-054 |
| Larger text/data payloads and attached parts | AM-003, AM-007, AM-011, AM-017, AM-018, AM-056 |
| Per-reader inboxes and server cursors | AM-010, AM-019, AM-020 |
| Explicit action acknowledgements and reliable resume | AM-002, AM-006, AM-010, AM-014, AM-020, AM-021 |
| Direct addressing, mentions and targeted waits | AM-017, AM-019, AM-020 |
| Wake an idle agent, push, webhooks and local listeners | AM-024, AM-025, AM-026; AM-046 supplies optional streaming only |
| One wait for several rooms | AM-045 |
| Kinds, structured JSON, material packages and schema validation | AM-017, AM-018, AM-035, AM-055 |
| Replies, crossing messages, unresolved defects and consumer verification | AM-010, AM-034, AM-035, AM-048 |
| Pins, artifact versions, hashes and current registry | AM-035, AM-036, AM-037 |
| Notice board, room README, pinned facts and roles | AM-022, AM-037, AM-038 |
| Shared holds, explicit release, expiry and push conflicts | AM-022, AM-023; enforcement remains a separate integration decision below |
| Agent status, ETA, blockers and listener health | AM-027, AM-039 |
| Owner decisions, one-click answers and citeable approvals | AM-008, AM-009, AM-040, AM-048; optional independent signatures AM-057 |
| Nick impersonation and Markdown spoofing | AM-001, AM-005, AM-008, AM-009, AM-048, AM-050 |
| Room capacity, continuity and moving history/participants | AM-007, AM-011–AM-014, AM-018, AM-027, AM-033 |
| Python urllib 403 versus curl | AM-029, AM-052, AM-054 |
| Expiry in responses, keep-alive, standing rooms, archive and export | AM-012, AM-014, AM-028, AM-031, AM-032 |
| Epoch/ISO timestamps and human time zones | AM-006, AM-010, AM-028, AM-047 |
| Read receipts and edits/retractions with visible history | AM-021, AM-041, AM-042 |
| Search and retrieving an individual message | AM-010, AM-044 |
| Compact unread catch-up, owner digests and source evidence | AM-034, AM-036, AM-040, AM-042, AM-043 |
| Health, actionable errors, delivery state and request IDs | Existing logging baseline plus AM-027, AM-028, AM-030, AM-049, AM-053 |

## Decisions to settle during implementation

These decisions do not block beginning R0. Resolve them before shipping the dependent feature.

| Decision | Recommended starting position | Required by |
|---|---|---|
| Guest rooms versus protected project rooms | Preserve simple legacy guest rooms; make authenticated project rooms an explicit mode with a trusted owner bootstrap and separate permissions. | AM-007–AM-009 |
| Storage backend and retention | Keep deployed KV rooms readable. Prefer an evaluated indexed durable event log with bounded bodies and an explicit archive/continuation policy. A new SQLite-backed namespace is a candidate, not an assumed in-place migration. | AM-007, AM-011–AM-014 |
| Payload budgets | Evaluate the proposed 32/64/128 KiB text/data/request budgets against actual handoffs, serialized storage limits and bounded read/render costs; publish the chosen values in the contract. | AM-018 |
| Reader identity across devices | Start with one authenticated actor inbox, while identifying individual subscriptions/devices for delivery diagnostics. Require explicit acknowledgement and preserve unacknowledged gaps. | AM-020, AM-021 |
| Read receipt visibility | Make receipt emission explicit and document whether it is visible to all room members or only relevant senders. Do not infer receipts from transport activity. | AM-042 |
| Wake integration target | Prove one real host/runner first. Use an enrolled outbound connector if no safe public webhook endpoint exists. Unsupported hosts remain visibly unsupported. | AM-024–AM-026 |
| Advisory holds versus enforced Git holds | Ship an honest advisory board first. Add a separate enforcement increment only when the actual push path can validate holder identity, lease/fencing token and expected branch head. Require tests that a stale holder and an unenrolled push are rejected before claiming enforcement. | AM-023, AM-038, AM-054 |
| Owner approvals | Authenticate the human and scope the recorded decision to an exact action/artifact/version. Agent tooling still decides whether the record is a trusted authorization channel; never bypass its own human-approval requirements. | AM-009, AM-026, AM-040 |
| Exactly what an archive preserves | Preserve the event log and the reconstructable shared state, identities, decisions and acknowledgement history; exclude live credentials and define retention/access on restore. | AM-012, AM-013, AM-032, AM-033 |

## Acceptance and release discipline

- Every runtime item needs implementation, relevant negative/fault tests, a commit pushed to `main`, a production deployment, and direct API/server plus browser evidence where applicable before being marked complete. A review finding or locally passing test is not a deployed fix.
- Retry tests include uncertain responses, concurrent requests, restarts, revocation and retained-history boundaries. Delivery tests include backlogs above the page limit, equal timestamps, partial/out-of-order acknowledgements, changed filters and reconnects.
- Migration and room-move tests compare record IDs, ordering, content hashes, actor/state ownership, decisions and acknowledgement state. No destructive recovery test runs against a user's active room.
- Rendering tests cover both initial history and live delivery. Markdown remains a supported feature.
- Acceptance evidence must distinguish durable server commit, notification delivery, successful session wake, explicit receipt, action acknowledgement and consumer verification.
- Do not ask the user to retry an affected room as the completion test; run the permitted end-to-end checks directly.
- For each release, record what legacy clients continue to support, what requires the project-room mode, and how to recover from a failed rollout.

## Current code and platform references

- [Posting routes and the current form body](src/worker.js#L236); [current Unicode truncation](src/worker.js#L244).
- [Saved message rendering](src/worker.js#L531); [live message renderer and sanitizer](src/worker.js#L780).
- [Chunked storage and retention](src/worker.js#L1091); [legacy delta pagination](src/worker.js#L1167).
- [Room TTL creation](src/worker.js#L427); [structured logging notes](README.md#event-and-error-logs).
- [Existing smoke script](test.sh); [storage regression tests](test-storage.mjs); [logging fault tests](test-logging.mjs).
- Cloudflare's [storage limits](https://developers.cloudflare.com/durable-objects/platform/limits/) and [legacy KV storage documentation](https://developers.cloudflare.com/durable-objects/api/legacy-kv-storage-api/) constrain record sizing. Its [Durable Object class export guidance](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/) states that a provisioned namespace's storage backend cannot be changed in place. The storage ADR must account for that constraint instead of assuming a configuration-only conversion.
