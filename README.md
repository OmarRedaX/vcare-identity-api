# vcare-identity-api — Identity & Access Service

Part of the **[Vcare Virtual Care Platform](https://github.com/OmarRedaX/Vcare)** — start there for the
PRD, architecture, service catalog, and cross-service contracts.

Owns **who someone is and whether they may act**: accounts, authentication, short-lived access tokens with
rotating refresh tokens, sessions, email verification, password management, account status, and service
tokens for service-to-service auth.

> **Status: foundation and auth built — `users` next.** On top of the foundation (Express 5 on a public and
> an internal listener, config, DI, errors, logging, request ids, validation, Knex, Redis, idempotency, rate
> limiting, graceful shutdown, health probes, Docker, CI) the whole public **auth** surface is in: email-first
> registration with a 6-digit code, login, rotating refresh sessions with reuse detection and a grace window,
> logout, password change / forgot / reset (typed code, ADR 0017), own profile, and JWKS — EdDSA tokens via
> `jose`, argon2id behind a bounded semaphore, deny-by-default `authorize`, plus the outbox worker (email via
> Resend or a local capture adapter) and retention purges. Five migrations: `users`, `refresh_tokens`,
> `password_resets`, `registration_challenges`, `outbox_jobs`.
> `npm test`: 51 suites / 491 tests pass (2026-10-05).
>
> **Open:** the `users` module (admin user management, status changes) and all of `/internal/*` (service
> tokens, batch lookup — Epic B) are not built. The foundation review
> ([`docs/foundation/reviews/`](./docs/foundation/reviews/)) has 19 open findings — 1 High (idempotency stores
> a `429` as completed), 5 Medium, 9 Low, 2 docs.

## Stack

Node.js 24 · TypeScript 5.9 · Express 5 · tsyringe (DI) · Knex + PostgreSQL 17 · ioredis + Redis 7 ·
zod (env schema) · class-validator / class-transformer (DTOs) · jose (EdDSA JWT / JWKS) · argon2
(bcrypt verify-only for legacy hashes) · Jest + supertest · ESLint 9.

One image, two processes: **api** (`src/server.ts` — public `:3000` under `/api`, internal `:3100` under
`/internal`) and **worker** (`src/worker.ts` — outbox and purge loops).

## Run it locally

```bash
npm install
cp .env.example .env                      # synthetic values only, never a real secret
npm run keys:generate -- --kid identity-local   # paste the output into JWT_PRIVATE_KEYS in .env
docker compose up -d postgres redis       # Postgres 17 on 5432, Redis 7 on 6379
npm run migrate                           # apply migrations (rollback / status also available)
npm run dev                               # public :3000, internal :3100
npm run dev:worker                        # outbox email delivery + purges (EMAIL_PROVIDER=capture
                                          # writes codes to .local/mail/outbox.jsonl)
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
npm run test:integration                                   # real Postgres + Redis, see below
```

`.env.test` points integration tests at local host instances: Postgres on 5432 (role `identity`, database
`vcare_identity_test`) and Redis database 1 on 6379. To use the compose test stack instead
(`docker compose -f docker-compose.test.yml up -d postgres redis`, ports 5435 / 6382), override
`DATABASE_URL` and `REDIS_URL` in your shell — real environment variables win over `.env.test`.
`scripts/curl-test-foundation.sh` replays the foundation manual QA against a running server.

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
| [docs/adr/](./docs/adr/) | service-level decisions (0001–0017) |
| [docs/foundation/](./docs/foundation/) | the foundation module: brainstorm, spec, task list, manual QA, open review |
| [docs/auth/](./docs/auth/) | the auth module: brainstorm, spec, and task list |
| [docs/users/](./docs/users/) | the users module (next): brainstorm and draft task list |

Platform-wide docs (overview, deployment, capacity, integration, data ownership) live only in the hub —
see hub [ADR 0008](https://github.com/OmarRedaX/Vcare/blob/main/adr/0008-doc-placement-by-scope.md).

**Related repos:** [Vcare (docs hub)](https://github.com/OmarRedaX/Vcare) ·
[vcare-care-api](https://github.com/OmarRedaX/vcare-care-api)
