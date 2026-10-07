---
title: Identity Service — Docs Index
owner: identity-team
service: identity-service
status: draft
last_verified: 2026-10-07
tags: [index, router, identity]
related: [service-card, system-design, runbook, quickstart]
---

# Identity Service — Docs Index

**Read this first.** Router for `identity-service` docs. Load only what you need. The **Lens** column
is the Diátaxis type — a label over the docs, not a folder tree. Binding rules live in `CLAUDE.md`
(cite sections by name, e.g. "CLAUDE.md → Security rules").

> Status (2026-10-07): the `foundation`, `auth` and `users` modules are built — the skeleton, both listeners, health
> probes, the cross-cutting `src/lib/` pieces, and the whole public auth surface (registration, login, refresh
> rotation, logout, password flows, own profile, JWKS) plus the outbox worker and retention purges; `users` (Epic A unit 2) adds admin
> list/get users, patient suspend/reinstate with `user_status_changes` history, session list/revoke, and the shared
> user-first lock order for refresh versus revocation (ADR 0019/0020). `/internal/*` (Epic B) is not built yet. The **auth and users contract changes are
> applied** (C-1…C-14 of [auth/spec.md](./auth/spec.md) §14.2); the architecture shards are reconciled with
> as-built auth code. Auth and users have unit and integration tests, a manual QA run and a code review whose findings are
> resolved (see [auth/tasks.md](./auth/tasks.md), [users/tasks.md](./users/tasks.md)). These docs are seeded from the PRD and `CLAUDE.md` and refined by
> the 2026-09-15 `/system-design` baseline — see
> [architecture/design-baseline.md](./architecture/design-baseline.md).

## Service-level
| Doc | Read it when you need to… | Lens |
|---|---|---|
| [service-card.md](./service-card.md) | 30-second summary (owner, data, dependencies, callers, endpoints) — synced to the hub | — |
| [system-design.md](./system-design.md) | find the architecture shard for a concern (router) | explanation |
| [quickstart.md](./quickstart.md) | run the service locally for the first time (deps, migrate, listeners, health, tests); the auth walkthrough is planned | tutorial |
| [runbook.md](./runbook.md) | on-call: an alert fired, rotate a key or client secret, revoke sessions, create an admin, trace a request | how-to |

## Architecture (one doc = one job)
| Doc | Read it when you need to… | Lens |
|---|---|---|
| [architecture/design-baseline.md](./architecture/design-baseline.md) | see the system-design decisions (D1–D17), target API surface, data-model delta, pending contract/`CLAUDE.md` changes | explanation |
| [architecture/capacity.md](./architecture/capacity.md) | check Identity's load, compute, storage, and Redis sizing derived from the hub's shared assumptions, and its 10× check | explanation |
| [architecture/deployment.md](./architecture/deployment.md) | see Identity's runtime components, availability targets, release specifics, bottlenecks and mitigations, metrics and alerts | explanation |
| [architecture/overview.md](./architecture/overview.md) | see the two listeners, worker, module map, layering, request pipeline | explanation |
| [architecture/data-model.md](./architecture/data-model.md) | look up tables, columns, constraints, indexes, ERD | reference |
| [architecture/api.md](./architecture/api.md) | look up an endpoint's roles, ownership, and error codes (human view of the contract) | reference |
| [architecture/auth-tokens.md](./architecture/auth-tokens.md) | understand signing keys, access claims, refresh rotation, grace window, reuse detection, revocation | explanation |
| [architecture/service-auth.md](./architecture/service-auth.md) | understand client credentials, scopes, the service guard, onboarding a new service client | explanation |
| [architecture/infrastructure.md](./architecture/infrastructure.md) | look up env vars (built vs planned), logging/redaction/metrics, error envelope, request id, health, shutdown, rate limits, idempotency, DB/Redis clients | reference |
| [architecture/future.md](./architecture/future.md) | see what is deliberately deferred (events, MFA and admin provisioning, PII erasure, social login, email change, AI client) | explanation |

## Decisions (append-only)
| ADR | Read it when you need to know why… | Lens |
|---|---|---|
| [adr/0001-no-orm-knex-raw-sql.md](./adr/0001-no-orm-knex-raw-sql.md) | there is no ORM and migrations are raw SQL | explanation |
| [adr/0002-asymmetric-jwt-rotating-refresh.md](./adr/0002-asymmetric-jwt-rotating-refresh.md) | tokens are EdDSA JWTs verified locally, refresh rotates, and the 15-min residual window is accepted | explanation |
| [adr/0003-argon2id-password-hashing.md](./adr/0003-argon2id-password-hashing.md) | passwords use argon2id with a bcrypt legacy fallback | explanation |
| [adr/0004-rejected-doctors-can-sign-in.md](./adr/0004-rejected-doctors-can-sign-in.md) | `rejected` accounts can log in and refresh (so Care's resubmission works) | explanation |
| [adr/0005-refresh-reuse-grace-window.md](./adr/0005-refresh-reuse-grace-window.md) | a just-rotated refresh token re-presented within 10 s does not revoke the family | explanation |
| [adr/0006-email-first-registration-otp.md](./adr/0006-email-first-registration-otp.md) | registration is start/complete with a 6-digit code and verify-email was removed | explanation |
| [adr/0007-transactional-outbox-worker.md](./adr/0007-transactional-outbox-worker.md) | emails and purges run through a Postgres outbox and a separate worker | explanation |
| [adr/0008-redis-tier-2-fallback-limiter.md](./adr/0008-redis-tier-2-fallback-limiter.md) | a Redis outage degrades rate limiting instead of blocking login | explanation |
| [adr/0009-availability-and-recovery-targets.md](./adr/0009-availability-and-recovery-targets.md) | the targets are 99.95 %, multi-AZ, with the stated RPO/RTO | explanation |
| [adr/0010-manual-admin-provisioning-role-policies.md](./adr/0010-manual-admin-provisioning-role-policies.md) | admins are inserted manually and set their password via reset; policies list roles explicitly | explanation |
| [adr/0011-pii-retained-on-soft-delete.md](./adr/0011-pii-retained-on-soft-delete.md) | soft-deleted accounts keep their PII in MVP (and when that is revisited) | explanation |
| [adr/0012-doctor-status-only-via-care.md](./adr/0012-doctor-status-only-via-care.md) | the admin status route refuses doctor targets | explanation |
| [adr/0013-log-derived-metrics.md](./adr/0013-log-derived-metrics.md) | metrics come from structured logs and there is no tracing SDK | explanation |
| [adr/0014-health-liveness-readiness-split.md](./adr/0014-health-liveness-readiness-split.md) | health is split into liveness and readiness | explanation |
| [adr/0015-foundation-runtime-dependencies.md](./adr/0015-foundation-runtime-dependencies.md) | `reflect-metadata` was added and there is no `cors`, `uuid`, or `dotenv` package (in-house CORS, `crypto.randomUUID`, Node env files) | explanation |
| [adr/0016-auth-runtime-dependencies.md](./adr/0016-auth-runtime-dependencies.md) | `jose`, `argon2` and `bcrypt` were added (bcrypt verify-only), and there is no cookie parser, Resend SDK, or HTTP client | explanation |
| [adr/0017-password-reset-by-one-time-code.md](./adr/0017-password-reset-by-one-time-code.md) | password reset is a typed 6-digit code instead of an emailed link token, and what bounds its 20 bits of entropy | explanation |
| [adr/0018-enumeration-timing-residual.md](./adr/0018-enumeration-timing-residual.md) | why known-versus-unknown email work in `register/start` and `forgot-password` is not equalised | explanation |
| [adr/0019-refresh-versus-suspension-lock-order.md](./adr/0019-refresh-versus-suspension-lock-order.md) | the lock order the status-change code and refresh rotation must share, and why `rotate` is not changed yet | explanation |
| [adr/0020-refresh-rotation-versus-revocation-lock-order.md](./adr/0020-refresh-rotation-versus-revocation-lock-order.md) | why refresh rotation versus family/user-wide revocation needed one shared lock order, and how `users` implemented it (`rotate` uses `FOR SHARE`) | explanation |
| [adr/0021-reason-field-not-redacted-in-logs.md](./adr/0021-reason-field-not-redacted-in-logs.md) | `reason` is not a logger redaction key and free-text status reasons are never logged | explanation |

## Contract (source of truth — prose above derives from it)
| Contract | Defines | Lens |
|---|---|---|
| [contracts/openapi.yaml](../contracts/openapi.yaml) | the whole HTTP API: public `/api/*`, `/.well-known/jwks.json`, internal `/internal/*`; roles (`x-roles`), ownership (`x-ownership`), scopes (`x-scope`), error codes | reference |

No AsyncAPI contract: MVP is HTTP-only. Planned events are listed under `x-future-events` in the
contract and in [architecture/future.md](./architecture/future.md).

## Modules
Module docs (`brainstorm.md`, `spec.md`, `tasks.md`, `manual-qa.md`, `reviews/`) appear under
`docs/<module>/` as the workflow creates them (`/brainstorm` creates the folder). Add a row here for each
module doc when it is created.

| Doc | Read it when you need to… | Lens |
|---|---|---|
| [foundation/brainstorm.md](./foundation/brainstorm.md) | see the agreed scope of the starter skeleton (what is in and out before any business module) | explanation |
| [foundation/spec.md](./foundation/spec.md) | build or change the skeleton: file list and exported APIs, env subset, error handler, logger redaction, idempotency and rate-limit behaviour, health, shutdown, Docker, CI, test plan; as-built divergences in §15 | reference |
| [foundation/tasks.md](./foundation/tasks.md) | see what was built for the skeleton, what is still open (hub sync, Knex log follow-up), and the test counts | reference |
| [auth/brainstorm.md](./auth/brainstorm.md) | see the agreed scope of the auth module (registration, login, refresh sessions, passwords, own profile, JWKS, token/RBAC infrastructure, outbox worker and email) and its open questions | explanation |
| [auth/spec.md](./auth/spec.md) | build or change the auth module: migrations for users/refresh_tokens/password_resets/registration_challenges/outbox_jobs, every auth + JWKS endpoint (guard, policy, limiters, idempotency, headers), refresh rotation algorithm, password reset by 6-digit code, `lib/auth`, `lib/rbac`, password hashing, outbox worker, email adapters, purges, env, test plan; ready (v1.1.0, no open questions); its contract edits C-1…C-14 are applied and the module is built | reference |
| [users/spec.md](./users/spec.md) | build or change the users module: admin list/get users, patient suspend/reinstate with `user_status_changes` history, session list/revoke, the shared status-change service method, and the ADR 0019/0020 lock order (user row first; `rotate` `FOR SHARE`) with its concurrency tests; ready (v1.0.1, no open questions; contract notes C-1/C-2 applied; as-built notes in §14, including refresh after suspension returning 401 `RefreshTokenInvalid`) | reference |
| [users/brainstorm.md](./users/brainstorm.md) | see the agreed scope of admin user management (list/get users, patient status changes with history, session list/revoke) and its open questions | explanation |
| [service-auth/brainstorm.md](./service-auth/brainstorm.md) | see the agreed scope of service-auth and internal-users (Cases 1-3, two modules, ops-provisioned clients, record-only `actorUserId`) and its open questions | explanation |
| [service-auth/spec.md](./service-auth/spec.md) | build or change service-auth: `service_clients` migration, `POST /internal/auth/token` (client credentials, per-IP and per-client limiters), `serviceGuard` and the `service` policy kind, internal listener wiring, health parity, ops provisioning/seed scripts, test plan; ready (v1.1.0, no open questions; contract edits C-1/C-2 to be applied in /develop step 0) | reference |
| [auth/tasks.md](./auth/tasks.md) | see Epic A's unit graph (auth then users, serial) and the auth build tasks and their status (build, tests and manual QA done; review findings resolved) | reference |
| [users/tasks.md](./users/tasks.md) | see the users build tasks and their status (all done; build, tests, manual QA and docs complete) | reference |
| [users/manual-qa.md](./users/manual-qa.md) | re-run or review the CURL checks of the five `/api/users` operations (RBAC, status transitions, session revocation, privacy) and the N-1 note on refresh after suspension | how-to |
| [auth/manual-qa.md](./auth/manual-qa.md) | re-run or review the CURL checks of every `/api/auth/*` operation and the JWKS (enumeration safety, idempotency, refresh rotation/reuse/grace, rate limits, no-store, log PII scan) and see the open defects | how-to |
| [foundation/manual-qa.md](./foundation/manual-qa.md) | re-run or review the CURL checks of health, request id, envelope, listener isolation, headers, CORS, and the readiness table with Redis/Postgres stopped | how-to |

---
_Platform-scope questions (platform overview, deployment topology, capacity assumptions, who calls us, Care's
contract, data ownership, glossary, PRD) → the hub, where they live exclusively (hub ADR 0008):
`../vcare-hub/INDEX.md` (on GitHub: [OmarRedaX/Vcare](https://github.com/OmarRedaX/Vcare/blob/main/INDEX.md)).
Do not clone another service just to read its docs._
