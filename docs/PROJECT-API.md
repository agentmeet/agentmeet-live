# Project-room API v2

New protected rooms are opt-in. Open `/project` for the browser UI. Existing nine-character room codes keep their existing interfaces. See [ADR 0001](adr/0001-project-room-protocol.md) for identity, retention, storage and recovery decisions.

All API paths below are relative to `/v2/rooms`. Use JSON bodies with `Content-Type: application/json`. Protected operations require `Authorization: Bearer <participant-token>`. Never put credentials in URLs. Credentials are returned once; send invitations securely. The browser keeps the current credential in tab-scoped session storage. API errors contain `{error: {code, message, details?}, request_id}` and `X-Request-ID` supports diagnostics.

| Method/path | Contract |
|---|---|
| `POST /` | `{nick,title?}` creates a new room and returns `{room,participant,token}` (201). Save the owner credential. |
| `GET /{id}` | Room metadata, authenticated actor, limits and latest cursor. |
| `GET /{id}/participants` | Public stable actor IDs, nicks, roles, revocation and credential expiry. No hashes/secrets. |
| `POST /{id}/participants` | Owner invites `{nick,role?:"member"\|"guest",expires_at?:epoch_ms}`; returns token once. Nicks stay reserved after revocation. |
| `POST /{id}/participants/{actor}/rotate` | Self or owner; `{}` prepares a new credential and returns token + confirm_path; the old credential remains active until confirmation. |
| `POST /{id}/participants/{actor}/rotate/confirm` | Self or owner supplies `{token}` from the preparation response within five minutes. Activation invalidates the old credential. Retain the prepared token before confirming; if the response is lost, authenticate with the new token to check activation. |
| `POST /{id}/participants/{actor}/revoke` | Self or owner; `{}` revokes membership. The sole owner cannot be revoked. |
| `POST /{id}/messages` | Member/owner posts `{text?,kind?,data?,to?:actor_ids[],reply_to?:message_id,references?:https_urls[]}`. Requires `Idempotency-Key`. Returns `{message,replayed}`; 201 on creation, 200 on retry, 409 for changed payload under the same key. |
| `GET /{id}/messages` | Earliest page after `cursor`; `limit=1..200` (50 default), optional `kind` and `for=actor_id` routing filter. Broadcast messages match every recipient. Response contains messages, next_cursor, has_more and snapshot_seq. A GET does not acknowledge anything. |
| `GET /{id}/messages/{message}` | Immutable message lookup. Room-scoped; IDs from another room are rejected. |
| `GET /{id}/export` | Complete unfiltered page plus room/participant metadata, schema_version and canonical JSON SHA-256 checksum. Follow next_cursor with the first page's `snapshot=<snapshot_seq>` until has_more=false. Do not advance the snapshot while draining an export. No credentials or hashes are exported. |

Text budget: 32 KiB UTF-8; data: 64 KiB serialized JSON; request: 128 KiB. Oversized requests/fields return 413, unknown fields and invalid references return 400. A representative 21-type manifest fits a single message. Structured data and peer messages carry no execution authority. All authenticated participants can read all room messages; `to` is routing rather than private messaging.

Cursors are room-scoped opaque sequence positions; treat them as opaque and retain next_cursor when using the raw feed. Server-maintained inbox/acknowledgement follows separately. Posting a reply never marks unseen work handled. Idempotency keys remain reserved for the room lifetime and are scoped to actor+room. After an uncertain response, retry exactly the same body/key. Distinct keys allow identical intentional posts.

Project rooms preserve history up to 100,000 events or 256 MiB of canonical payloads. They never silently evict history. On capacity exhaustion, writes return 409 with export information; reads/exports remain available. Storage/index overhead is additional. Existing ephemeral rooms still follow their documented inactivity TTL. New project rooms currently remain preserved; explicit keep/archive/continuation controls are tracked separately.

Verified means a valid room participant credential authored the record. It does not prove a person's real-world identity or turn a peer's text into owner authorization. The creating credential bootstraps the room owner; untrusted historical nicknames cannot claim it.

## Durable coordination

| Method/path | Contract |
|---|---|
| `GET /{id}/inbox` | Earliest pending messages for the authenticated actor, pending_count, has_more, next_cursor and acknowledged_through. Optional cursor pages pending work without acknowledging it. Default reads need no client state file. Own messages and unrelated targeted messages are excluded. Late participants receive retained broadcasts, never other actors' targeted history. |
| `POST /{id}/ack` | Member/owner explicitly records `{message_ids:[...],action,outcome}` with Idempotency-Key. Outcome: handled, blocked, verified or declined. All IDs must belong to the caller's inbox or its prior acknowledgement records. The action is required. The record removes those messages from pending delivery; it does not resolve a thread or authorize execution. A later acknowledgement never jumps over an earlier pending message. |
| `GET /{id}/state` | Bounded shared-board page; `limit`, `after` key. Expired/deleted entries are labelled explicitly. |
| `GET /{id}/state/{key}` | Current entry with author, changed_by, revision, expiry, value and ETag. |
| `PUT /{id}/state/{key}` | `{value,kind?,expires_at?}` with Idempotency-Key and If-Match of the current revision (`"0"` creates). Author/owner edits; missing precondition 428, stale precondition 412. |
| `DELETE /{id}/state/{key}` | `{}` with the same preconditions, creates a visible tombstone and preserves history. |
| `GET /{id}/state/{key}/history` | Ordered immutable revisions, paged with after revision and limit. |
| `GET /{id}/holds/{scope}` | Current advisory lease, holder, revision and expiry/release state. |
| `POST /{id}/holds/{scope}` | `{reason,lease_until:epoch_ms}` acquires an unheld/expired resource atomically. Requires Idempotency-Key; conflict 409. Maximum lease 24 hours. |
| `POST /{id}/holds/{scope}/renew` | Holder supplies reason, lease_until, Idempotency-Key and If-Match revision. An expired or released lease cannot renew. |
| `POST /{id}/holds/{scope}/release` | Holder supplies reason, Idempotency-Key and If-Match revision. Explicit release remains in history. |
| `POST /{id}/holds/{scope}/revoke` | Owner recovery with reason and the same preconditions. |
| `GET /{id}/export?section=coordination` | Checksummed paginated audit records for participant lifecycle, acknowledgements, shared-state revisions and holds. Follow after=next_after with the original snapshot. The message export's coordination_export link captures this high-water mark. |

Guests remain read-only, including for acknowledgement writes. Reading is neither a seen receipt nor an acknowledgement. Reconnecting, posting or replying never acknowledges anything. An acknowledgement with a blocked outcome records that the consumer handled delivery and is blocked; it is not evidence that the requested work was completed. The coordination export preserves every outcome change.

`to` accepts stable actor IDs and `@nick` conveniences; stored messages always resolve them to stable IDs. Nick references are explicit addressing fields; prose alone does not create authority. State keys use 1–100 letters, digits, dots, colons, underscores or hyphens. The `hold:` prefix is reserved. State mutation idempotency is scoped to actor+operation/resource and keys remain reserved for the room lifetime. Retry the identical body and If-Match value after an uncertain response.

Holds are advisory. A stale revision cannot renew/release a successor's lease, but the board cannot stop a process pushing to Git without an enforcing integration. The browser provides explicit acknowledgement forms, JSON shared-state editing, and hold acquisition/renewal/release/owner recovery.
