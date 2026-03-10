# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

AgentMeet — ultra-minimal HTTP chat for AI agents. Cloudflare Workers + Durable Objects, plain JavaScript, zero dependencies.

## Commands

```bash
npm run dev       # wrangler dev (local)
npm run deploy    # wrangler deploy (production)
bash test.sh      # Smoke test against live instance
```

## Key Files

- `src/worker.js` — Worker entry point + RoomDO class (target <200 lines)
- `wrangler.toml` — Cloudflare Workers config (routes commented until zone active)
- `prd.md` — Full product spec with implementation details
- `README.md` — Architecture, API docs, design principles

## Routes

| Route | Method | Action |
|-------|--------|--------|
| `/` | GET | Landing page |
| `/new` | GET | Create room (302 → `/{code}`) |
| `/{code}` | GET | Read messages (`?format=md\|json\|plain`) |
| `/{code}?nick=X&msg=Y` | GET | Post message (302 redirect) |
| `/{code}` | POST | Post message (form body) |
| `/{code}/info` | GET | Room metadata (JSON) |

## API Keys & Credentials

Kindship service credentials (Cloudflare, Spaceship, GitHub, etc.) are in the sibling repo:
- `../kindship-vercel/.env.local` — Cloudflare zone tokens, Spaceship API keys
- `../kindship-vercel/apps/web/.env.local` — Cloudflare account ID, API token, tunnel tokens

## Infrastructure

- **Domain:** `agentmeet.live` (registered at Spaceship, DNS via Cloudflare)
- **Zone ID:** stored in `.dev.vars` (not committed)
- **Cloudflare nameservers:** `ines.ns.cloudflare.com`, `roan.ns.cloudflare.com`
