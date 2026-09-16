# vcare-identity-api — Identity & Access Service

Part of the **[Vcare Virtual Care Platform](https://github.com/OmarRedaX/Vcare)** — start there for the
PRD, architecture, service catalog, and cross-service contracts.

Owns **who someone is and whether they may act**: accounts, authentication, short-lived access tokens with
rotating refresh tokens, sessions, email verification, password management, account status, and service
tokens for service-to-service auth.

> **Status: foundation landed — domain modules next.** The service runs: Express 5 on a public and an
> internal listener, config, DI, errors, logging, request ids, validation, Knex, Redis, idempotency, rate
> limiting, graceful shutdown, worker loop, health probes, the first migration, Docker and CI.
> `npm test` is green (23 unit suites / 161 tests); `npm run test:integration` runs 9 suites (55 passed,
> 2 signal-based shutdown cases skipped on Windows and green on Linux CI). No auth endpoints exist yet —
> [`contracts/openapi.yaml`](./contracts/openapi.yaml) is the design they get built against.

## Stack

Node.js 24 · TypeScript 5.9 · Express 5 · tsyringe (DI) · Knex + PostgreSQL 17 · ioredis + Redis 7 ·
zod (env schema) · class-validator / class-transformer (DTOs) · Jest + supertest · ESLint 9.

One image, two processes: **api** (`src/server.ts` — public `:3000` under `/api`, internal `:3100` under
`/internal`) and **worker** (`src/worker.ts` — outbox and purge loops).

## Run it locally

```bash
npm install
cp .env.example .env                      # synthetic values only, never a real secret
docker compose up -d postgres redis       # Postgres 17 on 5432, Redis 7 on 6379
npm run migrate                           # apply migrations (rollback / status also available)
npm run dev                               # public :3000, internal :3100
```

Check both listeners:

```bash
curl -s http://localhost:3000/api/health/ready
curl -s http://localhost:3100/internal/health/ready
# {"status":"ok","checks":{"database":"up","redis":"up"}}
```

`docker compose up -d` instead brings up the whole stack (postgres, redis, migrate, api, worker) from the
image. See [`docs/quickstart.md`](./docs/quickstart.md) for the full walkthrough.

## Test and check

```bash
npm run lint
npm run typecheck
npm test                                                   # unit
docker compose -f docker-compose.test.yml up -d postgres redis
npm run test:integration                                   # needs Postgres + Redis (5435 / 6382)
```

Fully hermetic (lint, typecheck, unit, integration in one container — what CI runs):

```bash
docker compose -f docker-compose.test.yml run --rm test
docker compose -f docker-compose.test.yml down -v
```

## Docs

| Read | For |
|---|---|
| [CLAUDE.md](./CLAUDE.md) | binding rules: stack, layering, security, domain rules, workflow |
| [docs/INDEX.md](./docs/INDEX.md) | service docs router (architecture, runbook, quickstart, ADRs) |
| [contracts/openapi.yaml](./contracts/openapi.yaml) | the HTTP API — source of truth |
| [docs/architecture/](./docs/architecture/) | overview, api, auth-tokens, data-model, infrastructure, deployment, capacity, design-baseline |
| [docs/adr/](./docs/adr/) | service-level decisions (0001–0015) |
| [docs/foundation/](./docs/foundation/) | the foundation module: brainstorm, spec, and live task list |

Platform-wide docs (overview, deployment, capacity, integration, data ownership) live only in the hub —
see hub [ADR 0008](https://github.com/OmarRedaX/Vcare/blob/main/adr/0008-doc-placement-by-scope.md).

**Related repos:** [Vcare (docs hub)](https://github.com/OmarRedaX/Vcare) ·
[vcare-care-api](https://github.com/OmarRedaX/vcare-care-api)
