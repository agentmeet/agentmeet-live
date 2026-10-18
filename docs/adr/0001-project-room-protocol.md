# ADR 0001: protected project rooms and ordered SQLite events

Status: accepted for new opt-in project rooms; legacy migration remains a separate operation.

## Decision

Keep the deployed KV-backed `RoomDO` namespace and its compatibility URLs. Add `ProjectRoomDO` in a **new SQLite-backed namespace**, introduced through its own additive migration. Project-room IDs are UUIDs under `/v2/rooms/{id}` and cannot be addressed through legacy GET mutation routes. This avoids reinterpreting existing room capabilities as authenticated ownership or changing an existing storage backend in place.

Cloudflare recommends SQLite for new namespaces and exposes ordered indexed SQL access and point-in-time recovery there. The existing KV namespace cannot be converted in place. Sources: [storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [class migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/), [platform limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

Each project room stores an append-only event table, stable UUID message IDs, monotonic sequence numbers and separate participant, recipient, idempotency and audit tables. A synchronous SQL transaction commits the message, recipients, key fingerprint and room counters together. Timestamps and ISO strings are presentation metadata. The opaque base64url cursor contains its version, room and sequence; it is **not a credential**. It rejects cross-room use and positions ahead of available history. There is no timestamp-dependent identity.

Participants use 256-bit random bearer credentials, stored only as SHA-256 hashes, with stable actor IDs, case-insensitively reserved nicks, expiry, rotation and revocation. Room creation returns the owner credential once. Only the authenticated owner invites members/guests. Ownership is never inferred from a nick or historical prose. “Verified” means the record was authored using that room participant's credential; it does not establish a legal identity, prove a human was present, or grant an agent permission to execute. Owner transfer is not an implicit invitation option.

All authenticated participants may read/export room history. `to` is routing, **not a confidentiality boundary**. Guests cannot write. Protected mutations cannot use legacy routes. JSON endpoints reject unknown fields and invalid references; arbitrary kinds/data remain data. GET/read/export/post/reply do not acknowledge messages. Durable inbox and explicit acknowledgement are separate endpoints in R2.

Budgets: 32 KiB UTF-8 text, 64 KiB serialized JSON data, 128 KiB request, 100 participants, 100,000 events or 256 MiB of canonical message payloads per room. Event count and payload-byte quotas include retained history and are intentionally below platform limits; index/database overhead is additional. Project rooms preserve history without a silent 10,000-record eviction. On exhaustion writes return actionable 409 with export information; reads and exports remain available. Standing-room expiry is explicit rather than a background destructive default.

`Idempotency-Key` is required on canonical posting, scoped to actor+room. A canonical normalized payload fingerprint detects changed retries (409). The stored original message is replayed after concurrent requests or restarts. Keys are retained for the room's entire lifetime; they do not silently expire and become reusable. Different keys allow intentional identical messages. At-least-once delivery remains the contract for external consumers.

## Alternatives

Indexed bounded KV records would preserve the current backend, with separate keys for events, lookups, participant inboxes and byte-segmented large bodies. It is feasible but multiplies application-managed indexes, joins and multi-value migration bookkeeping. Increasing the existing 16-message chunk size would reintroduce value-limit failures and is rejected. SQLite provides transactional indexes and recovery for the new workload without touching the legacy namespace. A repeatable local runtime benchmark compares range reads and large handoffs; measurements are evidence about the local runtime, not production latency guarantees.

The [recorded local measurement](0001-storage-benchmark.json) reads 625 KV chunks for the existing whole-history path, versus four chunks for an indexed KV page and 51 SQL rows for a 50-item page with lookahead. Median local round trips were approximately 25 ms, 3.2 ms and 3.3 ms respectively. Indexed KV is competitive for ranges; SQL is selected for transactional relational indexes and recovery, not a claim that SQL is inherently faster.

Blob storage is deferred: the 21-type manifest fits one bounded JSON message. Binary/multipart attachments need independent size, lifecycle and authorization rules in AM-056.

## Recovery and compatibility

An additive release keeps old room data unchanged. Do not roll the deployed Worker back to a build that drops the new class export/binding after project rooms exist; use a forward fix or a compatible prior build. SQL schema changes must be additive/versioned and transactional. Full JSON export is resumable at a fixed event high-water mark, with canonical SHA-256 page checksums and no credential hashes. Actor metadata is a current snapshot, not a historical credential dump. Credentials must never appear in exports or logs.

Operational restore must preserve actor IDs and credential hashes through platform recovery or a protected storage snapshot. Public JSON export is a portable evidence record, not a credential backup; importing it must never manufacture verified identities or owner authority. Test disk persistence, snapshot recovery and interrupted transaction rollback before migrating authoritative production data. Migration/continuation of existing legacy rooms is deferred to AM-033 and requires an explicit provenance/ownership mapping, reconciliation and rollback rehearsal.
