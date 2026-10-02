---
title: foundation — Tasks
owner: identity-team
service: identity-service
module: foundation
status: in-progress
diataxis: reference
last_verified: 2026-09-16
tags: [tasks, foundation, bootstrap, infrastructure, health, docker, ci]
related: [foundation-spec, foundation-brainstorm, foundation-manual-qa, infrastructure, deployment, overview, quickstart, adr-0014-health-liveness-readiness-split, adr-0015-foundation-runtime-dependencies]
---

# foundation — Tasks

Source: [spec.md](./spec.md) (status `implemented`, version 1.1.0 — as-built notes in §15). Each task is tagged with its step from CLAUDE.md →
"Build order for a new module". Statuses are kept live while building.

## Legend
- [ ] todo · [~] in progress · [x] done

## Units
Two independent units run in parallel for this feature (one per service, no shared files):

| Unit | Repo | Owner of |
|---|---|---|
| `care:foundation` | `../vcare-care-api` | care-service foundation skeleton (separate agent, separate working tree) |
| `identity:foundation` | this repo | identity-service foundation skeleton (this file) |

Cross-unit contract: the parity checklist in spec.md §12 (envelope, `X-Request-Id`, health bodies, idempotency
and rate-limit key formats, redaction mechanics, `sendSuccess`/`sendNoContent`/`sendRaw`). No file is shared
between the units; the hub sync and doc reconciliation happen after both land.

## Tasks

### Decisions and contract
- [x] (docs) `docs/adr/0015-foundation-runtime-dependencies.md` — reflect-metadata in, no cors/uuid/dotenv (spec §11.2)
- [x] (contract) four health operations `getPublicLiveness` / `getPublicReadiness` / `getInternalLiveness` / `getInternalReadiness` + `HealthLive` / `HealthStatus` schemas — applied to `contracts/openapi.yaml` 2026-09-15, not re-edited here (spec §3.3)

### Tooling
- [x] (tooling) `package.json` — deps, dev deps, scripts (spec §5)
- [x] (tooling) `tsconfig.json`, `tsconfig.build.json` (spec §4.1)
- [x] (tooling) `eslint.config.mjs` — forbidden imports, layering, no inline types (spec §6)
- [x] (tooling) `jest.config.js`, `jest.integration.config.js` (spec §9.1)
- [x] (tooling) `.gitignore` allowance for the committed `.env.test`

### lib and pkg
- [x] (enums-errors-types) `src/lib/config/` — `env.schema.ts`, `types.ts`, `load-env.ts`, `env.ts` (spec §4.2)
- [x] (enums-errors-types) `src/lib/di/` — `tokens.ts`, `container.ts` (spec §4.3)
- [x] (enums-errors-types) `src/lib/error/` — `types.ts`, `AppError.ts`, `errors.ts`, `errorHandler.ts` (spec §4.4)
- [x] (enums-errors-types) `src/lib/request-id/` — context + middleware (spec §4.5)
- [x] (enums-errors-types) `src/lib/logger/` — `redact.ts`, `logger.ts`, `request-logger.ts` (spec §4.6)
- [x] (enums-errors-types) `src/lib/http/` — response, no-store, cors, client-ip, route-capture, pagination (spec §4.7)
- [x] (enums-errors-types) `src/lib/validation/` (spec §4.8)
- [x] (enums-errors-types) `src/lib/types/` — `types.ts`, `express.d.ts` (spec §4.9)
- [x] (enums-errors-types) `src/lib/knex/` — `knexfile.ts`, `knex.ts` (spec §4.10)
- [x] (enums-errors-types) `src/lib/redis/` (spec §4.11)
- [x] (enums-errors-types) `src/lib/idempotency/` (spec §4.12)
- [x] (enums-errors-types) `src/lib/rate-limit/` (spec §4.13)
- [x] (enums-errors-types) `src/lib/worker/` — `run-loop.ts` (spec §4.14)
- [x] (enums-errors-types) `src/lib/lifecycle/` — `lifecycle.ts`, `inflight.ts` (spec §4.18)
- [x] (enums-errors-types) `src/pkg/utils/time.ts` + `types.ts` (spec §4.15)

### health module
- [x] (enums-errors-types) `src/app/health/enums.ts`, `types.ts` (spec §4.16)
- [x] (repository) `src/app/health/repository/health.repo.ts` — `pingDatabase`
- [x] (service) `src/app/health/service/health.service.ts` + container registration in `src/bootstrap.ts`
- [x] (response-dto) `src/app/health/dto/health.response.dto.ts`
- [x] (controller) `src/app/health/controller/health.controller.ts` + container registration
- [x] (routes) `src/app/health/routes.ts` — `GET /live`, `GET /ready`, sealed router (documented no-`authorize` probe exception)
- [x] (mount) `src/routes.ts` and `src/internal-routes.ts`

### entrypoints
- [x] (mount) `src/app.ts`, `src/internal-app.ts`, `src/types.ts` (spec §4.17)
- [x] (mount) `src/bootstrap.ts` — DI registration with overrides
- [x] (mount) `src/server.ts` — two listeners + graceful shutdown
- [x] (mount) `src/worker.ts` — empty loop + graceful stop
- [x] (mount) `src/migrate.ts` — `latest` / `rollback` / `rollback --all` / `status` / `make`

### database
- [x] (migration) `src/migrations/20260915000000_create_citext_extension.ts` (spec §2)

### packaging
- [x] (tooling) `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `docker-compose.test.yml`, `docker/postgres/init/01-create-test-database.sql` (spec §7)
- [x] (tooling) `.env.example`, `.env.test`
- [x] (tooling) `.github/workflows/ci.yml` (spec §8)

### tests
- [x] (tests) scaffolding — `tests/setup.ts`, `tests/integration/global-setup.ts`, `tests/helpers/{types,db,redis,app,log-capture,test-routers}.ts` (spec §9.1), plus `tests/helpers/contract.ts` (contract facts read from `contracts/openapi.yaml`) added by `/write-tests`
- [x] (tests) unit suites of spec §9.2 — `tests/unit/**`: 23 suites, 161 tests green (`npm test`)
- [x] (tests) integration suites of spec §9.3 — `tests/integration/**`: 9 suites, 55 passed, 2 skipped (`npm run test:integration`). The two signal-based shutdown cases in `process.test.ts` are skipped on Windows — `child.kill("SIGTERM")` maps to TerminateProcess, so Node's handlers never run — and execute on CI (ubuntu-latest).

### verification
- [x] (manual-qa) `npm install`, `npm run lint`, `npm run typecheck` green
- [x] (manual-qa) test stack up → `npm run migrate` applies, `rollback --all` reverses (citext dropped), `migrate` re-applies
- [x] (manual-qa) `GET /api/health/ready` returns 200 `{"status":"ok","checks":{"database":"up","redis":"up"}}` on both listeners, with `X-Request-Id` and `Cache-Control: no-store`; cross-listener paths return the 404 envelope
- [x] (manual-qa) CURL run recorded in `docs/foundation/manual-qa.md` + repeatable `scripts/curl-test-foundation.sh` — 35 cases, 35 pass / 0 fail (2026-09-16, ports 3020/3120 because host 3000 is occupied); scripted re-run `RUN_INFRA_CASES=1 bash scripts/curl-test-foundation.sh` → 57 assertions, 0 fail; readiness table rows `up/up`, `up/down → degraded`, `down → 503` all verified against `contracts/openapi.yaml`

### docs
- [x] (docs) `/update-docs foundation` follow-ups listed in spec §12 (infrastructure, quickstart, overview, api, runbook, service-card, INDEX) — done 2026-09-16, plus `deployment.md` (migrate command, `INTERNAL_HOST`/`TRUST_PROXY_HOPS`), `system-design.md`, `design-baseline.md` status line, INDEX rows for `tasks.md`, `manual-qa.md`, ADR 0015; spec bumped to 1.1.0 with As-built notes (§15). No contract drift found. The `CLAUDE.md` `lib/http/route-capture.ts` line is left for a human (spec §15.4)
- [x] (docs) hub sync — `cd ../vcare-hub && scripts/sync-from-spoke.sh identity-service ../vcare-identity-api` run 2026-09-16; hub card updated (contract copy already matched), hub freshness check OK

### follow-ups (reopened by `/update-docs`, 2026-09-16)
- [x] (enums-errors-types) `src/lib/knex/knexfile.ts` — route Knex's own warnings/errors through `Logger` so a Postgres outage writes only JSON lines (manual-qa.md → Failures / notes; spec §15.3)
