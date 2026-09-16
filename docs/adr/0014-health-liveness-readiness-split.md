---
title: "ADR 0014: Split health into liveness and readiness"
owner: identity-team
service: identity-service
status: accepted
date: 2026-09-15
diataxis: explanation
last_verified: 2026-09-15
tags: [adr, decision, health, availability, deployment]
related: [deployment, infrastructure, runbook, adr-0008-redis-tier-2-fallback-limiter]
---

# ADR 0014 — Split health into liveness and readiness

- **Status:** Accepted • **Date:** 2026-09-15 • **Deciders:** identity-team

## Context
`GET /api/health` and `GET /internal/health` returned `503` when either Postgres **or Redis** was down. Used by
the load balancer, a Redis outage would mark every task unhealthy at once and take Identity down, contradicting
ADR 0008 (Redis is Tier 2). Used by the orchestrator, a Postgres blip would restart healthy processes.

## Decision
| Endpoint (both listeners: `/api/health/*`, `/internal/health/*`) | Checks | 200 | 503 |
|---|---|---|---|
| `…/health/live` | process event loop responsive; no dependencies | `{ status: "ok" }` | never (process is dead or hung) |
| `…/health/ready` | Postgres `SELECT 1` (500 ms timeout) — fatal; Redis `PING` — reported only | `{ status: "ok" \| "degraded", checks: { database: "up", redis: "up" \| "down" } }` | Postgres down, or shutdown in progress |

- Load balancers use **readiness**; the orchestrator restarts on **liveness** only.
- The edge never routes `/api/health/*` (hub ADR 0005).
- Replaces `GET /api/health` and `GET /internal/health` (contract change).

## Consequences
- ➕ A Redis outage no longer drains the fleet; a Postgres blip no longer restart-loops tasks.
- ➕ Shutdown drain is expressed through readiness.
- ➖ Contract and runbook change; synthetic monitors must probe readiness.

## Alternatives considered
- **Keep one endpoint, but never 503 on Redis** — viable; rejected in favour of the standard live/ready split that
  the container platform expects.
