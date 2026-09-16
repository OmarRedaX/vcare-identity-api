---
title: "ADR 0008: Redis is Tier 2 — per-instance fallback rate limiter"
owner: identity-team
service: identity-service
status: accepted
date: 2026-09-15
diataxis: explanation
last_verified: 2026-09-15
tags: [adr, decision, redis, rate-limit, idempotency, availability]
related: [design-baseline, deployment, infrastructure, runbook, adr-0009-availability-and-recovery-targets]
---

# ADR 0008 — Redis is Tier 2: per-instance fallback rate limiter

- **Status:** Accepted • **Date:** 2026-09-15 • **Deciders:** identity-team

## Context
Rate limiters on credential routes (login, registration, reset, token) failed **closed** with `500` when Redis
was unreachable, and register idempotency failed closed too. That silently made Redis as critical as Postgres:
a Redis failover (30–60 s) meant no one could log in, and Identity's availability became the product of both.
The refresh limiter already failed open.

## Decision
- On a Redis error or timeout (50 ms), credential-route limiters switch to an **in-process sliding-window
  limiter** per task with limit `max(1, floor(limit / RATE_LIMIT_FALLBACK_DIVISOR))` (default divisor 2 = the
  minimum task count). Emit `rate_limiter_degraded` and alert `RateLimiterDegraded`.
- The refresh limiter keeps failing open (the refresh token is the protection).
- Idempotency: when Redis is unavailable, the middleware is **skipped**; duplicate `register/complete` is stopped by
  database constraints (challenge consumed atomically, unique live email) and returns `400`/`409` instead of a
  replayed `201`. Other idempotent POSTs likewise rely on their own natural constraints.
- Readiness does not depend on Redis (ADR 0014). Redis runs managed with a replica, but is **Tier 2**.

## Consequences
- ➕ Login, refresh, and registration survive Redis outages; availability depends on Postgres only.
- ➖ During an outage a distributed attacker gets up to roughly the per-instance limit × task count; the stricter
  divisor and edge WAF rules bound it.
- ➖ Duplicate submissions during an outage get an error instead of a replay.
- ➖ Two limiter implementations to test (Redis and in-process), including the switch-over.

## Alternatives considered
- **Fail closed + highly available Redis** — rejected: login outage during every Redis failover; couples
  Tier-1 availability to a cache.
- **Fail fully open** — rejected: an unlimited credential-stuffing window on a health platform.
