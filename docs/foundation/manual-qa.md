---
title: foundation — Manual QA (CURL)
owner: identity-team
service: identity-service
module: foundation
status: verified
diataxis: how-to
last_verified: 2026-10-04
tags: [manual-qa, curl, foundation, health, jwks, request-id, error-envelope, readiness, redis, redis-breaker, postgres]
related: [foundation-spec, foundation-tasks, adr-0014-health-liveness-readiness-split, adr-0008-redis-tier-2-fallback-limiter, quickstart, runbook]
contracts: [contracts/openapi.yaml]
---

# foundation — Manual QA (CURL)

_Run: 2026-10-04 • Server: http://localhost:3000 (public) / http://localhost:3100 (internal), dev compose stack • Result: 69 pass / 0 fail_

Stack: `docker compose up -d --build` (postgres 17, redis 7, migrate, api, worker) on a fresh volume, so the one-time
migration-name SQL fix from the quickstart was not needed. Host ports 5432 and 6379 were already taken by local
services, so Postgres and Redis were published on 5442 and 6389 through a throwaway compose override outside the repo;
api ports 3000/3100 were unchanged. Tokens and key material were never printed. Repeatable form:

```bash
PUBLIC_URL=http://localhost:3000 INTERNAL_URL=http://localhost:3100 RUN_INFRA_CASES=1 \
  COMPOSE_ARGS="-f docker-compose.yml" bash scripts/curl-test-foundation.sh
```

## Cases
Scripted (`scripts/curl-test-foundation.sh`, 65 assertions, 0 fail) — all roles are anonymous (foundation has no auth).

| # | Method | Path | Scenario | Expected | Got | Result |
|---|--------|------|----------|----------|-----|--------|
| 1 | GET | /api/health/live | happy path; body, `Cache-Control: no-store`, `X-Request-Id` | 200 `{"status":"ok"}` | same | pass |
| 2 | GET | /api/health/ready | all up | 200 `status: ok`, db up, redis up | same | pass |
| 3 | GET | /internal/health/live | happy path | 200 | 200 | pass |
| 4 | GET | /internal/health/ready | all up, no-store | 200 `status: ok` | same | pass |
| 5 | GET | /api/health/live | valid UUID request id | echoed | echoed | pass |
| 6 | GET | /api/health/live | uppercase UUID | adopted lower-cased | same | pass |
| 7 | GET | /api/health/live | malformed id / repeated header | regenerated, single header | same | pass |
| 8 | GET | /api/nope | error envelope carries sent request id in body and header | match | match | pass |
| 9 | GET | /internal/health/ready | internal listener echoes id | echoed | echoed | pass |
| 10 | GET | /internal/health/live on public, /api/health/live on internal | listener isolation | 404 `NotFound` | same | pass |
| 11 | GET | /.well-known/jwks.json | public listener serves, internal listener does not | 200 / 404 | 200 / 404 | pass |
| 12 | GET | /.well-known/jwks.json | `Cache-Control: public, max-age=300`, request id, bare `{"keys":[...]}` (no envelope), Ed25519 OKP, no private `d` | per contract | same | pass |
| 13 | GET | /api/definitely/not/here, /internal/..., / | unknown path | 404 envelope (`success:false`, `details:[]`, `requestId`) | same | pass |
| 14 | POST | /api/health/live | method not allowed on GET-only path | 404 envelope | 404 | pass |
| 15 | OPTIONS | /api/health/live, /internal/health/ready (no Origin) | no framework 200 | 404 envelope | 404 | pass |
| 16 | POST | /api/health/live | malformed JSON | 400 `ValidationFailed`, "must be valid JSON" | same | pass |
| 17 | GET | /api/health/live | helmet headers; no `X-Powered-By` | present / absent | same | pass |
| 18 | GET | /api/health/live | CORS allowed origin reflected, credentials, `Vary: Origin` | per spec | same | pass |
| 19 | GET | /api/health/live | disallowed origin | no CORS headers | none | pass |
| 20 | OPTIONS | /api/health/live | CORS preflight | 204, `Max-Age: 600` | same | pass |
| 21 | GET | /internal/health/live | internal listener never mounts CORS | none | none | pass |
| 22 | GET | both ready probes | Redis stopped | 200 `status: degraded`, redis down; liveness 200 | same | pass |
| 23 | GET | public ready | Redis restarted | 200 `status: ok` | same | pass |
| 24 | GET | both ready probes | Postgres stopped | 503 `status: down`, database down; liveness 200; 404 envelope still served | same | pass |
| 25 | GET | both ready probes | Postgres restarted | 200 `status: ok` | same | pass |

Manual (not scripted, needs `docker pause`):

| # | Method | Path | Scenario | Expected | Got | Result |
|---|--------|------|----------|----------|-----|--------|
| 26 | POST | /api/auth/login | Redis healthy, unknown account | 401 | 401 | pass |
| 27 | POST | /api/auth/login | Redis paused, same IP+email, requests 1-2 | 401 (fallback limit `floor(5/2)=2`), `rate_limiter_degraded` logged with `mode: fallback` | same | pass |
| 28 | POST | /api/auth/login | Redis paused, request 3-8 | 429 `RateLimited` (`degraded: true`), fast (~0.2 s, no Redis wait) | 429 | pass |
| 29 | GET | /api/health/ready | Redis paused | 200 `degraded` (not 503) | 200 degraded | pass |
| 30 | GET | /api/health/live | Redis paused | 200 | 200 | pass |
| 31 | n/a | log events | pause Redis, then unpause and wait > 15 s cooldown | `redis_breaker_open` (cooldownMs 15000), then `redis_breaker_half_open`, `redis_breaker_closed` | all three seen, in order | pass |
| 32 | POST | /api/auth/login | after recovery, new emails | 401 (limiter back on Redis, no degraded log) | 401, no new degraded events | pass |
| 33 | GET | /api/health/ready | after unpause | 200 `ok` | 200 ok | pass |

Total: 65 scripted + 4 distinct manual outcomes counted (27/28 combined, 29, 31, 32) = 69 pass / 0 fail.

## Failures / notes
- No real failures.
- Environment: host ports 5432 and 6379 were occupied (a local Postgres and Redis not owned by this stack), so
  `docker compose up` failed with "ports are not available". Worked around with a compose override published on
  5442/6389; not an application defect, but `docker-compose.yml` has no env-driven host-port knob.
- Worker log during the Postgres outage shows `knex_warn` / `worker_tick_failed` as JSON lines only (expected,
  spec §15.3) and the worker kept running and stayed up after Postgres returned.
- `scripts/curl-test-foundation.sh` was extended: a "C2. JWKS" section (Cache-Control, request id, bare key set, no
  private member) and a `COMPOSE_ARGS` variable so the infra cases can drive the dev stack or an override file.
  Default behaviour against the test stack is unchanged.
- Redis breaker: with Redis paused (process frozen, TCP still connected) the first two login attempts used the
  fallback limiter, the breaker opened about 1 s after the first degraded event, and it closed on the first request
  after the cooldown once Redis was unpaused. Login stayed available throughout.
