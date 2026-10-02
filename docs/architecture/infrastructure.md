---
title: Identity Service — Infrastructure and Cross-Cutting Concerns
owner: identity-team
service: identity-service
status: draft
diataxis: reference
last_verified: 2026-09-16
tags: [architecture, infrastructure, env, logging, health, rate-limit, idempotency, shutdown]
related: [system-design, overview, auth-tokens, runbook, quickstart, deployment, foundation-spec, adr-0008-redis-tier-2-fallback-limiter, adr-0013-log-derived-metrics, adr-0014-health-liveness-readiness-split, adr-0015-foundation-runtime-dependencies]
---

# Infrastructure and Cross-Cutting Concerns

> **As-built status (2026-09-16):** the `foundation` module is built. The env schema, logger and redaction, error
> envelope, request id, health, shutdown, idempotency and rate-limit middleware, knex/Redis clients, and the worker
> loop exist in `src/lib/` and `src/app/health/`. Exact behaviour: [foundation/spec.md](../foundation/spec.md)
> (as-built notes in §15). Anything marked **planned** lands with the auth, users, service-auth, and outbox modules.

## 1. Environment variables (`src/lib/config/env.schema.ts`, zod)
Every variable is declared in the zod schema (`env.schema.ts`; `env.ts` exports the parsed `env`). **Secrets have no
defaults.** If parsing fails, the process refuses to start: exit code 1 and one JSON line `invalid_environment` naming
the invalid keys, never their values. Empty strings count as unset. Unknown variables are ignored. Cross-field
rules: `INTERNAL_PORT` ≠ `PORT`; `LOG_LEVEL=debug` is rejected when `NODE_ENV=production`.

The **In code** column says whether the variable is in the schema today (`foundation`) or arrives with a later
module (`planned`).

| Variable | Type / format | Default | Secret | In code | Purpose |
|---|---|---|---|---|---|
| `NODE_ENV` | `development` \| `test` \| `production` | `development` | no | foundation | dev-only behaviour (debug logs, CORS); HSTS and `debug` rejection in production |
| `PORT` | int 1..65535 | `3000` | no | foundation | public listener (binds all interfaces) |
| `INTERNAL_PORT` | int 1..65535, ≠ `PORT` | `3100` | no | foundation | internal listener |
| `INTERNAL_HOST` | IPv4 or IPv6 address | `127.0.0.1` | no | foundation | interface the internal listener binds to; a container deployment sets the task's private interface (dev compose uses `0.0.0.0`) |
| `TRUST_PROXY_HOPS` | int 0..10 | `0` | no | foundation | Express `trust proxy` on both apps = number of proxy hops in front of the task; drives `req.ip` for rate-limit and idempotency subjects |
| `DATABASE_URL` | `postgres://` or `postgresql://` URL | — | yes | foundation | identity database |
| `DATABASE_POOL_MAX` | int 1..100 | `10` | no | foundation | Knex pool size per process |
| `REDIS_URL` | `redis://` or `rediss://` URL | — | yes | foundation | rate limits, idempotency |
| `CORS_ORIGINS` | comma-separated bare `http`/`https` origins (no path) | empty | no | foundation | CORS allowlist, local development only; in production it is ignored with a `cors_origins_ignored_in_production` warning (hub ADR 0005) |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` | `info` | no | foundation | `debug` rejected when `NODE_ENV=production` |
| `SHUTDOWN_TIMEOUT_MS` | int 1000..60000 | `10000` | no | foundation | graceful shutdown deadline (API and worker) |
| `RATE_LIMIT_FALLBACK_DIVISOR` | int ≥ 1 | `2` | no | foundation | per-instance fallback limit = max(1, floor(limit / divisor)) when Redis is down (ADR 0008) |
| `WORKER_POLL_INTERVAL_MS` | int 100..60000 | `1000` | no | foundation | worker loop interval (ADR 0007) |
| `JWT_PRIVATE_KEYS` | JSON array of `{ kid, privateJwk }` (Ed25519 OKP), ≥ 1 entry, unique `kid` | — | yes | planned | signing key set; public halves published as JWKS |
| `JWT_ACTIVE_KID` | string, must match a `kid` in `JWT_PRIVATE_KEYS` | — | no | planned | key used to sign new tokens |
| `JWT_ISSUER` | string | `vcare-identity` | no | planned | `iss` claim |
| `ACCESS_TOKEN_TTL_SECONDS` | int | `900` | no | planned | user access token lifetime |
| `REFRESH_TOKEN_TTL_DAYS` | int | `30` | no | planned | refresh token lifetime and cookie `Max-Age` |
| `SERVICE_TOKEN_TTL_SECONDS` | int | `300` | no | planned | service token lifetime |
| `APP_BASE_URL` | URL | — | no | planned | base for links in password-reset emails |
| `EMAIL_PROVIDER_API_KEY` | string | — | yes | planned | email provider credential |
| `EMAIL_PROVIDER_FROM` | email address | — | no | planned | sender address |
| `EMAIL_PROVIDER_BASE_URL` | URL | — | no | planned | provider API endpoint |
| `OTP_PEPPER` | string ≥ 32 bytes | — | yes | planned | HMAC key for registration codes (ADR 0006) |
| `REFRESH_REUSE_GRACE_SECONDS` | int 0..30 | `10` | no | planned | refresh grace window (ADR 0005) |
| `HASH_CONCURRENCY` | int ≥ 1 | vCPU count | no | planned | argon2 semaphore size |
| `HASH_QUEUE_MAX` | int ≥ 0 | `50` | no | planned | queued hashes before `429 RateLimited` |
| `WORKER_BATCH_SIZE` | int 1..100 | `20` | no | planned | jobs claimed per poll (worker only) |
| `OUTBOX_MAX_ATTEMPTS` | int ≥ 1 | `8` | no | planned | attempts before a job is `dead` (worker only) |

Planned rows come from the 2026-09-15 baseline ([deployment.md](./deployment.md) → New configuration).
`APP_BASE_URL` is still needed: it builds the password-reset links (verification links no longer exist, ADR 0006).
The foundation added `TRUST_PROXY_HOPS`, which replaces the unnamed "ingress hop count" setting.

Time arithmetic from these values uses `pkg/utils/time.ts` (`addTime`, `toMs`) — never inline math.

## 2. Logging
Custom structured JSON `Logger` (`lib/logger/logger.ts`), one line per event, to stdout. The logger never throws.

| Field | Always | Notes |
|---|---|---|
| `level` | yes | `debug` (dev only, always dropped in production), `info`, `warn`, `error` |
| `message` | yes | stable snake_case event name; no emojis |
| `timestamp` | yes | ISO-8601 UTC |
| `service` | yes | `identity-service` |
| `requestId` | on request paths | from `lib/request-id` (AsyncLocalStorage) |
| `userId` | when a user token is verified (planned guard) | numeric id only |
| `clientId` | when a service token is verified (planned guard) | `client_id` |
| `route` | on request completion | route pattern (`/api/users/:id`), not the raw URL; `unmatched` when no route matched |
| `status` | on request completion | HTTP status; `499` when the client closed before the response finished |
| `durationMs` | on request completion | rounded to 0.1 ms |

**Never logged:** passwords, password hashes, access/refresh/reset/verification tokens, client secrets,
`Authorization` and `Cookie` headers, email addresses, phone numbers, full names, request bodies of
`/auth/*`. The logger redacts keys by name as defence in depth (`password`, `newPassword`,
`currentPassword`, `passwordHash`, `token`, `accessToken`, `refreshToken`, `access_token`, `refresh_token`,
`client_secret`, `clientSecret`, `clientSecretHash`, `tokenHash`, `codeHash`, `privateJwk`, `authorization`,
`cookie`, `set-cookie`, `email`, `phone`, `fullName`). Callers still must not pass them. Error stacks are logged
server-side only, and only on `error` lines.

**Redaction mechanics (`lib/logger/redact.ts`, identical in care-service; the key list differs).** Keys match after
normalization (lower-case, `-` and `_` removed), so `access_token`, `accessToken`, and `Access-Token` all match. Matching
works at any depth, including arrays of objects, and the value becomes `"[REDACTED]"`. An `Error` becomes
`{ name, message, code?, stack? }`. Depth > 8 becomes `"[Truncated]"` and a circular reference `"[Circular]"`; `bigint`
becomes a string and `Date` an ISO string; functions and symbols are dropped. The input is never mutated. Fields cannot
override `level`, `message`, `timestamp`, or `service`.

**Request log (`lib/logger/request-logger.ts`).** One `request_completed` line per request (`error` level when
status ≥ 500, else `info`) with `method`, `route`, `status`, `durationMs`. Health routes are **not** logged unless
the status is ≥ 500. Headers, query strings, raw URLs, and bodies are never logged.

**Metrics (`logger.metric()`, ADR 0013).** One embedded-metric-format line: `message: "metric"`,
`_aws.CloudWatchMetrics` with namespace `vcare/identity-service`, the value under the metric name, and redacted
dimensions. `LOG_LEVEL` never suppresses it. Emitted today: `rate_limited` and `rate_limiter_degraded` (dimension
`limiter`). The rest of the metric set in [deployment.md](./deployment.md) → Observability is planned.

Security-relevant events logged at `warn` with a stable `message` (used by alerts): `rate_limited` (as built);
`refresh_token_reuse_detected`, `login_failed`, `service_token_denied`, `status_changed` (info) — planned.

**Knex output:** Knex's own warnings, errors and deprecations are routed through `Logger` via the `log` option
built by `buildKnexLog` (`lib/knex/knexfile.ts`), so a Postgres outage writes JSON lines only:
`knex_warn` / `knex_error` / `knex_deprecated` with `detail` = the first line of the message (no stack). The
request pool (`lib/knex/knex.ts`) and the migration CLI pass the logger; test-only configs may omit it.

## 3. Error envelope
`lib/error/errorHandler.ts` is the **only** producer of error responses:

```json
{ "success": false, "error": { "code": "ValidationFailed", "message": "Request validation failed", "details": [{ "field": "email", "issue": "must be an email" }], "requestId": "7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b" } }
```

- Services throw `AppError` instances (stable `code`, HTTP status, message); shared instances live in
  `lib/error/errors.ts` and `withDetails(...)` returns a copy.
- `class-validator` failures become `400 ValidationFailed` with one `details` entry per failing field (dotted path;
  an unknown property is `is not allowed`).
- `details` is **always present** — `[]` when there are none. Key order: `success`, `code`, `message`, `details`,
  `requestId`.
- Body-parser failures are `400 ValidationFailed` on `field: "body"`: `must be valid JSON`, `must not exceed 100kb`,
  `has an unsupported encoding`. An unmatched path on either listener is `404 NotFound`.
- Unknown errors become `500 InternalError`; the body never contains a stack, SQL, or internal message.
- The same envelope is used byte-for-byte by care-service. Codes: [api.md](./api.md) → Error code catalogue.

## 4. Request id
`lib/request-id` is the first request-scoped middleware on both apps. It accepts an incoming `X-Request-Id` only if
it is a single UUID, and adopts it **lower-cased**. A malformed or repeated header gets a fresh `crypto.randomUUID()`.
It sets `req.requestId` and echoes the header on every response (including 404, 400, 429, 500, and health). It binds
the id to every log line through `AsyncLocalStorage`. The users module (planned) also stores it on
`user_status_changes.request_id`. Care forwards its request id on internal calls, so one id spans both services.

## 5. Health checks (ADR 0014, as built)
`src/app/health/` serves the same router on both listeners:

| Endpoint | Listener | Checks | 200 | 503 |
|---|---|---|---|---|
| `GET /api/health/live`, `GET /internal/health/live` | public / internal | none — process only | `{ "status": "ok" }` (also during shutdown) | never |
| `GET /api/health/ready`, `GET /internal/health/ready` | public / internal | run concurrently: Postgres `SELECT 1` (500 ms), **fatal**; Redis `PING` (500 ms; immediately `down` if the client is not connected), **reported only** | `{ "status": "ok" \| "degraded", "checks": { "database": "up", "redis": "up" \| "down" } }` | `{ "status": "down", "checks": { … } }` when Postgres is down or shutdown is in progress |

Load balancers use readiness; the orchestrator restarts on liveness. The edge never routes `/api/health/*`.
Health responses:
- are bare objects (not enveloped);
- carry `X-Request-Id` and `Cache-Control: no-store`;
- need no token and are not rate-limited;
- are the only routes without `authorize(...)` (the documented probe exception).

A 503 logs `readiness_failed` at `warn` with `{ checks, shuttingDown }`. The public listener does not serve
`/internal/health/*`, and the internal listener does not serve `/api/health/*` (404).

## 6. Graceful shutdown (`src/server.ts`, `src/worker.ts`)
API process, on `SIGTERM` / `SIGINT` (runs at most once; a second signal reuses the first run):
1. `lifecycle.markShuttingDown()` — readiness returns 503; log `shutdown_started { reason }`.
2. `server.close()` on **both** listeners (stop accepting) plus `closeIdleConnections()`; in-flight requests continue.
3. Wait for both listeners to close (in-flight requests and their transactions finish), raced against
   `SHUTDOWN_TIMEOUT_MS`.
4. Nothing to flush: email work is durable in `outbox_jobs` (ADR 0007).
5. Destroy the Knex pool; `redis.quit()` (falls back to `disconnect()`).
6. Exit 0. If the deadline passes first: log `shutdown_timeout { unfinishedRequests }`, `closeAllConnections()` on
   both listeners, run step 5, exit 1.

Uncaught exceptions and unhandled rejections log `uncaught_exception` / `unhandled_rejection` at `error`, run the
same sequence, and exit **1**. Both listeners use `keepAliveTimeout` 65 s and `headersTimeout` 66 s (longer than a
60 s load-balancer idle timeout).

Worker process: log `worker_stopping` and stop the loop (the current tick finishes, no new tick starts), raced against
`SHUTDOWN_TIMEOUT_MS`. Then destroy the pool, disconnect Redis, and exit 0. On timeout it logs
`worker_shutdown_timeout` and exits 1. Unfinished outbox leases (planned) are re-claimed after `locked_until`.

## 7. Rate limiting and idempotency

### 7.1 Limiters (planned per route; the middleware exists)
| Limiter | Route | Key subject | Limit | Window |
|---|---|---|---|---|
| `login-ip-email` | `POST /api/auth/login` | IP + sha256(lower(email)) | 5 | 1 min |
| `login-ip` | `POST /api/auth/login` | IP | 20 | 1 min |
| `register-start-email` | `POST /api/auth/register/start` | sha256(lower(email)) | 3 | 1 h |
| `register-start-ip` | `POST /api/auth/register/start` | IP | 5 | 1 h |
| `register-complete-ip` | `POST /api/auth/register/complete` | IP | 10 | 1 h |
| `forgot-email` | `POST /api/auth/forgot-password` | sha256(lower(email)) | 3 | 1 h |
| `reset-ip` | `POST /api/auth/reset-password` | IP | 10 | 1 h |
| `refresh-family` | `POST /api/auth/refresh` | `family_id` | 30 | 1 min |
| `service-token-client` | `POST /internal/auth/token` | `client_id` | 60 | 1 min |

The register rows replace `register-ip`, `resend-email`, and `verify-ip` from the current contract (ADR 0006). Each
registration challenge also allows at most 5 code attempts.

### 7.2 Limiter mechanics (`lib/rate-limit`, as built)
- `rateLimit({ name, limit, windowMs, subject, degrade })` is route-level and runs **before** body validation and
  (later) password hashing, so rejected attempts cost no argon2 work.
- Redis key `rl:<name>:<subject>` (same format in care-service). Callers hash subjects that contain PII, so Redis
  keys hold no PII; the subject is never logged.
- Algorithm: a sliding-window log in one atomic Lua script on the Redis clock (`TIME`). Rejected attempts are not
  recorded. Each Redis call is bounded at 50 ms.
- A tripped limiter returns `429 RateLimited` with `Retry-After` (seconds, ≥ 1), logs `rate_limited { limiter, degraded }`
  at `warn`, and emits the `rate_limited` metric.
- Client IP is `req.ip` with IPv4-mapped IPv6 normalized. `X-Forwarded-For` is honoured only across
  `TRUST_PROXY_HOPS` proxy hops (0 locally, so it cannot be spoofed).
- **Redis unavailable (ADR 0008 — Redis is Tier 2)**, meaning the client is not ready, the script errors, or it takes > 50 ms:
  - `degrade: "fallback"`: credential routes (login, register start/complete, forgot, reset, token) switch to a
    process-wide **in-process per-task limiter** at `max(1, floor(limit / RATE_LIMIT_FALLBACK_DIVISOR))` (at most
    10 000 keys, oldest evicted).
  - `degrade: "fail-open"`: used by the refresh limiter, because the refresh token itself is the protection.
  - Either mode logs `rate_limiter_degraded { limiter, mode }` and emits the metric, at most once per 60 s per
    limiter; alert `RateLimiterDegraded`. When Redis is back, the next request uses Redis again.

### 7.3 Idempotency (`lib/idempotency`, as built)
Route-level, after guard and authorize. `Idempotency-Key` must be a single UUID. The Redis key is
`idem:<METHOD> <concrete baseUrl+path>:<principal>:<lower-cased key>`. It uses the concrete path (never the route
pattern, never the query string); the principal is `user:<id>`, `client:<clientId>`, or `ip:<addr>` (same format in
care-service). The body hash is sha256 of a JSON serialization that ignores key order.

| Situation | Result |
|---|---|
| header missing, key required | `400 ValidationFailed` (`field: Idempotency-Key`, `is required`) |
| header missing, key optional | handler runs, no Redis access |
| header not a UUID, or repeated | `400 ValidationFailed` (`must be a UUID`) |
| Redis not ready, or a pre-handler Redis call errors or exceeds 100 ms | middleware skipped, `idempotency_skipped { reason }` at `warn`; database constraints stop duplicates (ADR 0008) |
| first use (`SET NX` of an in-flight record, 60 s) | handler runs; status < 500 → record stored for **24 h**; status ≥ 500 or client disconnect → record deleted so a retry re-executes |
| same key, different body | `422 IdempotencyConflict` |
| same key and body, completed | original status and body replayed without running the handler; a replayed error gets the current `error.requestId`; headers are not replayed |
| same key and body, still in flight | `409 Conflict` with `Retry-After: 1` |

## 8. Database and Redis connections
- Knex over `pg`, pool `min 0` / `max DATABASE_POOL_MAX`; each new connection runs `SET TIME ZONE 'UTC'`.
- Pool acquire timeout 1 s (fast-fail on pool wait); statement timeout 2 s on request and worker paths.
- Migrations run separately (`src/migrate.ts`: `latest`, `rollback`, `rollback --all`, `status`, `make <name>`)
  on a 2-connection pool with no statement timeout. Run them with `npm run migrate` locally and
  `node dist/migrate.js latest` in the `identity-migrate` task; a bare `node dist/migrate.js` exits 1. The first
  migration creates the `citext` extension.
- Hot-path queries are `EXPLAIN`ed before merge (CLAUDE.md → Performance rules).
- Redis (`ioredis`) connects lazily in the background at boot, so a Redis outage never blocks startup. The offline
  queue is disabled so commands fail fast, with 1 retry per request, a 2 s connect timeout, and endless reconnects
  (backoff ≤ 2 s). Logs: `redis_ready`, `redis_error` (at most once per 10 s, error name only), `redis_connect_failed`.

## 9. Security headers, body parsing, and CORS
- `helmet` defaults on both listeners; HSTS only on the public listener in production. `X-Powered-By` disabled.
- JSON body parser (`application/json`, strict, 100 kb limit) on both listeners.
- CORS (in-house middleware, ADR 0015) runs on the public listener only and **only outside production**:
  - exact-match allowlist from `CORS_ORIGINS`;
  - allowed origins get `Access-Control-Allow-Origin`, `Allow-Credentials: true`,
    `Expose-Headers: X-Request-Id, Retry-After`, and `Vary: Origin`;
  - preflights answer `204` with methods `GET, POST, PATCH, DELETE, OPTIONS`, headers
    `Authorization, Content-Type, Idempotency-Key, X-Request-Id`, and `Max-Age: 600`.

  The internal listener sends no CORS headers.
- `Cache-Control: no-store` on every health response (as built) and on every `/api/auth/*` response (planned;
  `lib/http/no-store.ts` provides the middleware).

## 10. Background work
Background work runs outside any request, in the separate `identity-worker` process (`src/worker.ts`, ADR 0007).
**As built**, the worker runs one loop (`lib/worker/run-loop.ts`) every `WORKER_POLL_INTERVAL_MS` with an empty tick.
Ticks never overlap; a failing tick logs `worker_tick_failed` and the loop continues. The jobs below are **planned**
(outbox module):
- **Email delivery** from the transactional outbox (`outbox_jobs`): jobs `send_registration_code`,
  `send_account_exists_notice`, `send_password_reset`. The worker generates the code or token at send time, stores
  its hash, and calls the provider through the `lib/email` port (5 s timeout). It retries with exponential backoff
  and marks the job `dead` after `OUTBOX_MAX_ATTEMPTS`.
- **Purges** under `pg_try_advisory_lock`, in batches of 5 k rows: `refresh_tokens` and `password_resets` 30 days
  after expiry/revocation/use, `registration_challenges` after 24 h, `outbox_jobs` `done` after 7 days and `dead`
  after 30 days.

Neither may block or fail a request. Metrics: `outbox_oldest_pending_age_s`, `outbox_dead_jobs`
([deployment.md](./deployment.md) → Observability).
