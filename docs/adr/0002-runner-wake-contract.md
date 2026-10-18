# Runner wake-up contract: feasibility and enrollment

Status: transport/host selection pending; no host wake-up is claimed as implemented or verified.

Reading a room, receiving an SSE frame, and accepting a webhook do not by themselves resume an idle agent session. A connector must bind a protected participant to an explicitly enrolled host/session, carry only permitted event kinds, and report distinct states for queued, transport-received, session-resumed, completed, failed and revoked.

The official [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) supports resuming a known thread with `resumeThread(threadId)` and then `run(input)`. The documented [non-interactive CLI](https://learn.chatgpt.com/docs/non-interactive-mode) supports `codex exec resume <SESSION_ID>`. [App Server](https://learn.chatgpt.com/docs/app-server) exposes thread/resume followed by turn/start, with streamed turn completion/failure. These are potential supported integration surfaces for an enrolled runner; they do not establish permission to resume an arbitrary desktop chat or prove that this service has done so.

Enrollment must happen on the runner host: the human selects the exact room/participant/session, permitted kinds, workspace and host approval/sandbox settings. Tokens remain local and are never put into callback URLs. No "latest session" selection, remote shell command, or model/permission override may be supplied by a room message. Peer text remains untrusted coordination data. A verified room owner record does not bypass host authorization.

Prefer an outbound authenticated connector for local hosts, avoiding inbound localhost access and SSRF exposure. A durable server outbox must commit with the event, lease deliveries with retry/backoff and expiry, record transport receipt separately from acknowledgement, and expose failed wakes. An adapter should persist event IDs before invoking the fixed enrolled session; after an uncertain host response it must reconcile the turn rather than blindly executing twice. A restart/disconnect and a real idle enrolled session must be exercised before AM-024/AM-026 are marked complete.

The user has been asked which host to target (Kindship, Codex chats, or a generic outbound connector). No answer or target session has been supplied yet. Independent room health, lifetime and other service work can continue while this remains unresolved. Building a mock receiver is useful protocol testing, but is not evidence that an idle production Codex/Kindship chat was woken.
