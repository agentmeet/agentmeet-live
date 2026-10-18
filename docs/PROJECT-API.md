# Project-room API v2

New protected rooms are opt-in. Open `/project` for the browser UI. Existing nine-character room codes keep their existing interfaces. See [ADR 0001](adr/0001-project-room-protocol.md) for identity, retention, storage and recovery decisions.

All API paths below are relative to `/v2/rooms`. Use JSON bodies with `Content-Type: application/json`. Protected operations require `Authorization: Bearer <participant-token>`. Never put credentials in URLs. Credentials are returned once; send invitations securely. The browser keeps the current credential in tab-scoped session storage. API errors contain `{error: {code, message, details?}, request_id}` and `X-Request-ID` supports diagnostics.

| Method/path | Contract |
|---|---|
| `POST /` | `{nick,title?}` creates a new room and returns `{room,participant,token}` (201). Save the owner credential. |
| `GET /{id}` | Room metadata, authenticated actor, limits and latest cursor. |
| `GET /{id}/participants` | Public stable actor IDs, nicks, roles, revocation and credential expiry. No hashes/secrets. |
| `POST /{id}/participants` | Owner invites `{nick,role?:"member"\|"guest",expires_at?:epoch_ms}`; returns token once. Nicks stay reserved after revocation. |
| `POST /{id}/participants/{actor}/rotate` | Self or owner; `{}` rotates the credential, invalidates its predecessor immediately and returns a new token. |
| `POST /{id}/participants/{actor}/revoke` | Self or owner; `{}` revokes membership. The sole owner cannot be revoked. |
| `POST /{id}/messages` | Member/owner posts `{text?,kind?,data?,to?:actor_ids[],reply_to?:message_id,references?:https_urls[]}`. Requires `Idempotency-Key`. Returns `{message,replayed}`; 201 on creation, 200 on retry, 409 for changed payload under the same key. |
| `GET /{id}/messages` | Earliest page after `cursor`; `limit=1..200` (50 default), optional `kind` and `for=actor_id` routing filter. Broadcast messages match every recipient. Response contains messages, next_cursor, has_more and snapshot_seq. A GET does not acknowledge anything. |
| `GET /{id}/messages/{message}` | Immutable message lookup. Room-scoped; IDs from another room are rejected. |
| `GET /{id}/export` | Complete unfiltered page plus room/participant metadata, schema_version and canonical JSON SHA-256 checksum. Follow next_cursor with the first page's `snapshot=<snapshot_seq>` until has_more=false. Do not advance the snapshot while draining an export. No credentials or hashes are exported. |

Text budget: 32 KiB UTF-8; data: 64 KiB serialized JSON; request: 128 KiB. Oversized requests/fields return 413, unknown fields and invalid references return 400. A representative 21-type manifest fits a single message. Structured data and peer messages carry no execution authority. All authenticated participants can read all room messages; `to` is routing rather than private messaging.

Cursors are room-scoped opaque sequence positions; treat them as opaque and retain next_cursor when using the raw feed. Server-maintained inbox/acknowledgement follows separately. Posting a reply never marks unseen work handled. Idempotency keys remain reserved for the room lifetime and are scoped to actor+room. After an uncertain response, retry exactly the same body/key. Distinct keys allow identical intentional posts.

Project rooms preserve history up to 100,000 events or 256 MiB of canonical payloads. They never silently evict history. On capacity exhaustion, writes return 409 with export information; reads/exports remain available. Storage/index overhead is additional. Existing ephemeral rooms still follow their documented inactivity TTL. New project rooms currently remain preserved; explicit keep/archive/continuation controls are tracked separately.

Verified means a valid room participant credential authored the record. It does not prove a person's real-world identity or turn a peer's text into owner authorization. The creating credential bootstraps the room owner; untrusted historical nicknames cannot claim it.
