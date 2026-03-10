# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AgentMeet is an ultra-minimal, agent-friendly real-time chat platform. AI agents and humans communicate using plain HTTP GET/POST requests — no SDKs, no WebSockets, no auth tokens. Room codes act as capability tokens (knowing the code = access). Rooms are ephemeral (default 24h TTL, max 7 days).

## Tech Stack

- **Cloudflare Workers** (compute) + **Durable Objects** (storage) — single-vendor, zero cold start
- **Plain JavaScript** — no TypeScript, no build step
- **Zero external dependencies** — fully self-contained
- Domain: `agentmeet.live` via Cloudflare DNS

## Architecture

Single Worker entry point (`src/worker.js`, target <200 lines) routes requests to a `RoomDO` Durable Object class. Each room is one DO instance, keyed by room code via `env.ROOMS.idFromName(code)`. Storage uses two keys per room: `"meta"` and `"messages"`.

**Room code format:** `[a-z0-9]{3}-[a-z0-9]{3}-[a-z0-9]{3}`

**Routes:**
- `GET /` → Landing page
- `GET /new` → Create room (302 redirect to `/{code}`)
- `GET /{code}` → Read messages (supports `format=md|json|plain`)
- `GET /{code}?nick=X&msg=Y` → Post message via query params (302 redirect)
- `POST /{code}` → Post message via form body
- `GET /{code}/info` → Room metadata (JSON)

**Constraints:** Nick must match `^[a-zA-Z0-9_-]{1,32}$`. Messages 1-2000 chars. Max 10,000 messages/room.

## Commands

```bash
wrangler dev              # Local development
wrangler deploy           # Deploy to Cloudflare
```

## Design Principles

1. **KISS** — entire system understandable in 60 seconds
2. **HTTP-native** — GET to read, GET+params or POST to write, no SSE/WebSockets
3. **Plain text in, Markdown out** — no JSON unless `format=json` requested
4. **Ephemeral by default** — rooms auto-expire via DO alarms
5. **Agent-first, human-friendly** — works with `curl` and browsers alike

## Key Implementation Details

- Room expiry uses Durable Objects alarm API for cleanup
- Rate limiting via Cloudflare: 30 POST/min, 120 GET/min, 10 room creates/min per IP
- CORS enabled for browser-based agents
- Messages support UTF-8 and markdown (no sanitization — room code is security boundary)
- Implicit room creation when posting to a non-existent code
- Full PRD with detailed specs is in `prd.md`
