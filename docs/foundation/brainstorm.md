---
title: foundation — Brainstorm
owner: identity-team
service: identity-service
module: foundation
status: draft
diataxis: explanation
last_verified: 2026-09-15
tags: [brainstorm, foundation, bootstrap, infrastructure, testing, ci, docker]
related: [system-design, infrastructure, deployment, overview, quickstart, adr-0007-transactional-outbox-worker, adr-0008-redis-tier-2-fallback-limiter, adr-0014-health-liveness-readiness-split]
---

# foundation — Brainstorm

## Problem & purpose
No application code exists. Every business module (`auth`, `users`, `sessions`, `service-auth`, …) needs the same
runnable skeleton first: two listeners, the one error envelope, request ids, a redacting logger, env validation,
DI, Postgres + Redis connections, idempotency and rate-limit middleware, health, a worker entrypoint, Docker,
CI, and a real test environment. This module builds that skeleton — **only what every module needs on day one**.
Structural reference (not a rulebook): `../../Core service ( Quick bite )` — its `src/lib`, `src/pkg`, `tests/helpers`,
`docker-compose.test.yml`, `Dockerfile`, `.github/workflows/ci.yml`. Where it disagrees with CLAUDE.md, CLAUDE.md wins
(e.g. no `jsonwebtoken`, no `bcrypt` for new hashes, no `uuid`/`dotenv`, `X-Request-Id`, one error envelope with codes).
The foundation must stay byte-compatible with care-service's foundation (same envelope, request-id, health shape).

## Actors
Developers and agents building later modules; the orchestrator (health probes); CI.

## In scope (this iteration)
- **Tooling:** `package.json` (Node 24, scripts `dev`, `dev:worker`, `build`, `start`, `start:worker`, `typecheck`, `lint`,
  `test` (unit), `test:integration`, `migrate`, `migrate:rollback`, `migrate:make`), `tsconfig.json`
  (`strict`, `noUncheckedIndexedAccess`, decorators + `emitDecoratorMetadata`), ESLint flat config with
  `no-restricted-imports` enforcing the forbidden-library list and layering (`pkg/` ↛ `lib/`,`app/`; `lib/` ↛ `app/`),
  Jest configs for unit and integration.
- **Entrypoints:** `src/server.ts` (both listeners; `INTERNAL_HOST` bind; graceful shutdown per infrastructure.md §6
  incl. uncaught exception/rejection handling), `src/app.ts` (`/api`), `src/internal-app.ts` (`/internal`),
  `src/routes.ts`, `src/internal-routes.ts`, `src/worker.ts` (**empty runnable skeleton**: poll loop runner, no jobs,
  graceful stop after the current tick — ADR 0007).
- **lib/:** `config/env.ts` (zod — only variables the foundation uses; later modules add theirs; exit 1 naming
  invalid keys never values; `LOG_LEVEL=debug` rejected in production), `di/`, `error/` (`AppError`, `errorHandler`,
  shared codes `ValidationFailed`, `NotFound`, `Conflict`, `IdempotencyConflict`, `RateLimited`, `InternalError`,
  `Unauthorized`, `Forbidden`), `logger/` (structured JSON, `service="identity-service"`, redaction list from
  infrastructure.md §2, request logging with route pattern/status/durationMs), `request-id/`, `http/` (`response.ts`,
  `no-store` helper, `pagination/`, in-house CORS allowlist middleware on the public listener only), `validation/`,
  `knex/` (`SET TIME ZONE 'UTC'`, 2 s statement timeout on request paths), `redis/`, `idempotency/`
  (`idempotency({ required })`, skipped when Redis is down — ADR 0008), `rate-limit/` (Redis sliding window factory,
  `429` + `Retry-After`, `rate_limited` warn log, per-limiter degrade mode: `fallback` in-process
  `max(1, floor(limit / RATE_LIMIT_FALLBACK_DIVISOR))` + `rate_limiter_degraded`, or `fail-open`), `types/express.d.ts`.
- **pkg/utils/:** `time.ts` (`addTime`, `toMs`) only.
- **Health module** `src/app/health/` — `GET /api/health/live|ready`, `GET /internal/health/live|ready` per ADR 0014.
- **First migration:** `CREATE EXTENSION IF NOT EXISTS citext` (proves the pipeline; needed by `users.email`).
- **Docker:** multi-stage `Dockerfile` (node:24-alpine, non-root, one image for `identity-api` and `identity-worker`;
  argon2 native build needs build tools in the builder stage — only once argon2 lands, keep the stage ready),
  `.dockerignore`, `docker-compose.yml` (postgres 17 on host 5432, redis 7 on host 6379, api, worker, migrate step),
  `docker-compose.test.yml`, `.env.example`, `.env.test`.
- **CI:** `.github/workflows/ci.yml` — install, lint, typecheck, unit, integration (Postgres + Redis service
  containers, migrations), docker build.
- **Test environment:** `tests/setup.ts` (no infra mocks), `tests/helpers/` (`db.ts`, `redis.ts`, `app.ts`, log
  capture for "no secrets/PII in logs"). Unit tests for every lib piece; integration tests for health, request id,
  error envelope, idempotency and rate limits (incl. Redis-down fallback) against real Postgres/Redis, mounted on
  test-only routers inside the suite.

## Out of scope
`lib/auth` (jwt/jwks/guards), `lib/rbac`, `lib/email`, `lib/outbox`, `pkg/utils/crypto.ts`, argon2, any business
table or route, the JWKS endpoint. Each lands with the first module that needs it.

## Key entities & relationships
None. Redis keys: `idem:<route>:<principal>:<key>`, `rl:<name>:<subject>`.

## Primary flows / endpoints (with roles + ownership)
| Endpoint | Auth | Notes |
|---|---|---|
| `GET /api/health/live`, `GET /internal/health/live` | none | `{ "status": "ok" }` |
| `GET /api/health/ready`, `GET /internal/health/ready` | none | `{ status: ok\|degraded, checks: { database, redis } }`; 503 on Postgres down or shutdown |
Health routes are the only routes without `authorize(...)` (documented infrastructure-probe exception).

## Business rules & state transitions
Readiness: Postgres down ⇒ 503; Redis down ⇒ 200 `degraded`; shutting down ⇒ 503.
Idempotency: same key + same body ⇒ replay; different body ⇒ 422; required + missing ⇒ 400.

## Cross-service touchpoints (case, direction, failure policy)
None implemented.

## Privacy & audit
Logger redaction list built in and unit-tested; request bodies never logged.

## Constraints & guideline notes
Runtime deps limited to the locked stack plus **`reflect-metadata`** → ADR `0015-foundation-runtime-dependencies`.
No `cors`, `uuid`, `dotenv` packages. Inline types only in `types.ts`.

## Contract changes expected
Replace `GET /api/health` and `GET /internal/health` with the four live/ready operations (ADR 0014).

## Open questions
None blocking. Hub sync needed after the contract change (`../vcare-hub/scripts/sync-from-spoke.sh`).

## Success criteria
`docker compose up` serves `GET /api/health/ready` 200; `npm run lint`, `typecheck`, `test`, `test:integration`
green locally and in CI; worker starts and stops cleanly; docs (infrastructure, quickstart, overview, service card,
INDEX) describe the as-built skeleton.
