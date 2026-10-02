---
title: foundation — Manual QA (CURL)
owner: identity-team
service: identity-service
module: foundation
status: verified
diataxis: how-to
last_verified: 2026-09-16
tags: [manual-qa, curl, foundation, health, request-id, error-envelope, readiness, redis, postgres]
related: [foundation-spec, foundation-tasks, adr-0014-health-liveness-readiness-split, adr-0008-redis-tier-2-fallback-limiter, quickstart, runbook]
contracts: [contracts/openapi.yaml]
---

# foundation — Manual QA (CURL)

_Run: 2026-09-16 • Server: http://localhost:3020 (public) / http://localhost:3120 (internal) • Result: 35 pass / 0 fail_

_(35 scenarios below; the scripted form asserts each one's status, body, and headers separately and reports
**57 pass / 0 fail** — same cases, finer granularity.)_

The foundation module exposes **no business endpoints** — the only routes are the four health probes
(spec §3, ADR 0014). Everything else verified here is cross-cutting behaviour that every later module
inherits: the error envelope, `X-Request-Id`, listener isolation, security headers, CORS, and the
readiness decision table.

## How this run was set up

Host port 3000 is occupied by an unrelated application on the QA machine, so the service was started on
**3020 (public) / 3120 (internal)** instead of the documented local defaults 3000/3100. Paths and bodies
are unaffected; only the base URLs differ.

```bash
# test stack (already up): host 5435 = Postgres, 6382 = Redis
docker compose -f docker-compose.test.yml up -d --wait

export NODE_ENV=development PORT=3020 INTERNAL_PORT=3120 INTERNAL_HOST=127.0.0.1 \
  DATABASE_URL="postgres://identity:identity@localhost:5435/vcare_identity_test" \
  REDIS_URL="redis://localhost:6382/1" LOG_LEVEL=info CORS_ORIGINS="http://localhost:5173"

npx tsx src/migrate.ts latest    # migrations_applied {batch:1,count:0} — already at latest
npx tsx src/migrate.ts status    # migrations_status  {completed:1,pending:[]}
npx tsx src/server.ts            # server_listening public:3020 + internal:3120, redis_ready
```

Repeatable form of every case below: [`scripts/curl-test-foundation.sh`](../../scripts/curl-test-foundation.sh).

## Cases

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 1 | GET | /api/health/live | public | happy path, public listener | 200 `{"status":"ok"}`, `X-Request-Id`, `Cache-Control: no-store` | exactly that | pass |
| 2 | GET | /api/health/ready | public | happy path, both deps up | 200 `{"status":"ok","checks":{"database":"up","redis":"up"}}` + headers | exactly that | pass |
| 3 | GET | /internal/health/live | public (internal listener) | happy path | 200 `{"status":"ok"}` + headers | exactly that | pass |
| 4 | GET | /internal/health/ready | public (internal listener) | happy path | 200 `{"status":"ok","checks":{...up,up}}` + headers | exactly that | pass |
| 5 | GET | /api/health/live | public | valid lowercase UUID in `X-Request-Id` | same id echoed | echoed unchanged | pass |
| 6 | GET | /api/health/live | public | valid **uppercase** UUID | adopted, lower-cased (spec §4.5) | lower-cased echo | pass |
| 7 | GET | /api/health/live | public | malformed id `not-a-uuid` | fresh UUID generated, not echoed | fresh UUID | pass |
| 8 | GET | /api/health/live | public | `X-Request-Id` sent twice | repeated header rejected → fresh UUID | fresh UUID | pass |
| 9 | GET | /api/nope | public | request id present on an error response | 404 envelope, `requestId` = sent id, header echoed | matched | pass |
| 10 | GET | /internal/health/ready | public (internal listener) | request id honoured on the internal listener | echoed | echoed | pass |
| 11 | GET | /internal/health/live | public **listener** | listener isolation: internal path on public port | 404 `NotFound` envelope | 404 `NotFound` | pass |
| 12 | GET | /api/health/live | internal listener | listener isolation: api path on internal port | 404 `NotFound` envelope | 404 `NotFound` | pass |
| 13 | GET | /.well-known/jwks.json | public | route not in foundation scope (lands with auth) | 404 `NotFound` envelope | 404 `NotFound` | pass |
| 14 | GET | /api/definitely/not/here | public | unknown public path | 404 envelope, `details: []` | `details` present as `[]` | pass |
| 15 | GET | /internal/definitely/not/here | internal | unknown internal path | 404 envelope, `details: []` | `details` present as `[]` | pass |
| 16 | GET | / | public | root path, outside `/api` | 404 envelope | 404 envelope | pass |
| 17 | POST | /api/health/live | public | wrong method on an existing path | 404 `NotFound` (no method router registered) | 404 `NotFound` | pass |
| 18 | POST | /api/health/live | public | malformed JSON body | 400 `ValidationFailed`, `details[0] = {field:"body", issue:"must be valid JSON"}` | exactly that | pass |
| 19 | GET | /api/health/live | public | security headers | helmet set, `X-Powered-By` absent | CSP, `nosniff`, `no-referrer`, COOP/CORP present; no `X-Powered-By` | pass |
| 20 | GET | /api/health/live | public | CORS, allowed dev origin | `Access-Control-Allow-Origin`, `-Credentials: true`, `Expose-Headers`, `Vary: Origin` | exactly that | pass |
| 21 | GET | /api/health/live | public | CORS, origin not in allowlist | request served, **no** CORS headers | no CORS headers | pass |
| 22 | OPTIONS | /api/health/live | public | CORS preflight, allowed origin | 204 + `Allow-Methods`, `Allow-Headers`, `Max-Age: 600` | exactly that | pass |
| 23 | GET | /internal/health/live | internal | internal listener never mounts CORS | no CORS headers even with `Origin` | no CORS headers | pass |
| 24 | GET | /api/health/ready | public | **Redis stopped** | 200 `{"status":"degraded","checks":{"database":"up","redis":"down"}}` | exactly that (observed 1 s after stop) | pass |
| 25 | GET | /internal/health/ready | internal | **Redis stopped** | 200 `degraded`, `redis: down` | exactly that | pass |
| 26 | GET | /api/health/live | public | liveness ignores Redis | 200 `{"status":"ok"}` | 200 `ok` | pass |
| 27 | GET | /api/health/ready | public | Redis restarted | back to 200 `ok` / `redis: up` | recovered after 6 s | pass |
| 28 | GET | /internal/health/ready | internal | Redis restarted | back to 200 `ok` | recovered | pass |
| 29 | GET | /api/health/ready | public | **Postgres stopped** | 503 `{"status":"down","checks":{"database":"down","redis":"up"}}` | exactly that (observed 1 s after stop) | pass |
| 30 | GET | /internal/health/ready | internal | **Postgres stopped** | 503 `status: down` | exactly that | pass |
| 31 | GET | /api/health/live | public | liveness never 503 on a dep outage | 200 `{"status":"ok"}` | 200 `ok` | pass |
| 32 | GET | /internal/health/live | internal | liveness never 503 on a dep outage | 200 `{"status":"ok"}` | 200 `ok` | pass |
| 33 | GET | /api/nope | public | error envelope still served with Postgres down | 404 envelope (no 500) | 404 envelope | pass |
| 34 | GET | /api/health/ready | public | Postgres restarted | back to 200 `ok` | recovered after 5 s | pass |
| 35 | GET | /internal/health/ready | internal | Postgres restarted | back to 200 `ok` | recovered | pass |

Readiness decision table (spec §3.2) exercised: rows 1 (`up/up → 200 ok`), 2 (`up/down → 200 degraded`),
and 3 (`down/any → 503 down`). Row 4 (shutting down → 503) is covered by the integration suite, not here —
see "Not exercised".

## Failures / notes

No functional failures. Two observations, neither a contract violation:

- **Knex writes an unstructured, ANSI-coloured line to stdout during a Postgres outage.** While Postgres was
  stopped, each readiness check emitted `Acquire connection error: AggregateError [ECONNREFUSED]` plus a raw
  stack trace, printed by Knex's default logger rather than by `lib/logger`. The service's own line is
  correct and structured (`{"level":"warn","message":"readiness_failed",…,"checks":{"database":"down","redis":"up"},"shuttingDown":false}`),
  and no PII or secret is leaked, but the extra output is not JSON and would pollute a log pipeline that
  parses one JSON object per line (CLAUDE.md → Privacy and logging). Fix would be a `log:` override in
  `buildKnexConfig` (`src/lib/knex/knexfile.ts`) routing Knex warnings through `Logger`. Recorded, not fixed
  — QA does not change `src/`.
- **`request_completed` is logged for health routes only when the status is ≥ 500**, as specified
  (spec §4.6). Confirmed: the 503 readiness produced an `error`-level `request_completed`, while the 200
  probes produced none. Not a defect — noted so a future reader does not treat the silence as a bug.

## Not exercised, and why

| Area | Why not | Where it is covered |
|---|---|---|
| Idempotency middleware (`lib/idempotency`) | reachable only through the test-only routers, which are deliberately **not** mounted in `src/routes.ts`; no product endpoint uses it yet | integration suite (`tests/integration/`), spec §4.12 table |
| Rate limiting (`lib/rate-limit`) | same — no mounted route is rate-limited in the foundation | integration suite, spec §4.13 table |
| Readiness during shutdown (503 while draining) | needs a real `SIGTERM`; on Windows `child.kill("SIGTERM")` maps to `TerminateProcess`, so Node's handler never runs | integration `process.test.ts` (skipped on Windows, runs on CI ubuntu-latest) |
| `/.well-known/jwks.json`, all `/api/auth/*`, `/api/users/*`, `/internal/users*`, `/internal/auth/token` | not built yet — they land with the auth, users, and internal modules | contract only (`contracts/openapi.yaml`) |
| Service tokens / user tokens on `/internal/*` | no guard exists yet; `/internal/health/*` is intentionally token-free (contract `security: []`, `x-scope: none`) | later modules |

## Contract conformance

Checked against `contracts/openapi.yaml` (`getPublicLiveness`, `getPublicReadiness`, `getInternalLiveness`,
`getInternalReadiness`) and `docs/foundation/spec.md` §3:

- `HealthLive` — `{status: "ok"}`, bare object, not enveloped. Matches.
- `HealthStatus` — `{status: ok|degraded|down, checks:{database: up|down, redis: up|down}}`, `down` exactly
  when the response is 503. Matches on both listeners.
- `ErrorEnvelope` — `{success:false, error:{code, message, details, requestId}}` with `details` always
  present as `[]`. Matches; `code` values seen were `NotFound` and `ValidationFailed`, both in the contract's
  `ErrorCode` enum.
- `X-Request-Id` on every response, `Cache-Control: no-store` on all four health responses (both 200 and
  503). Matches.

No contract drift found for this module.
