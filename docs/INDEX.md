---
title: Identity Service — Docs Index
owner: identity-team
service: identity-service
status: draft
last_verified: 2026-09-14
tags: [index, router, identity]
related: [service-card, system-design, runbook, quickstart]
---

# Identity Service — Docs Index

**Read this first.** Router for `identity-service` docs. Load only what you need. The **Lens** column
is the Diátaxis type — a label over the docs, not a folder tree. Binding rules live in `CLAUDE.md`
(cite sections by name, e.g. "CLAUDE.md → Security rules").

> Status: design only — no application code exists yet. These docs are seeded from the PRD and
> `CLAUDE.md`; `/system-design` refines them and `/update-docs` reconciles them with as-built code.

## Service-level
| Doc | Read it when you need to… | Lens |
|---|---|---|
| [service-card.md](./service-card.md) | 30-second summary (owner, data, dependencies, callers, endpoints) — synced to the hub | — |
| [system-design.md](./system-design.md) | find the architecture shard for a concern (router) | explanation |
| [quickstart.md](./quickstart.md) | run the service locally for the first time and walk the auth flow with curl | tutorial |
| [runbook.md](./runbook.md) | on-call: an alert fired, rotate a key or client secret, revoke sessions, trace a request | how-to |

## Architecture (one doc = one job)
| Doc | Read it when you need to… | Lens |
|---|---|---|
| [architecture/overview.md](./architecture/overview.md) | see the two listeners, module map, layering, request pipeline | explanation |
| [architecture/data-model.md](./architecture/data-model.md) | look up tables, columns, constraints, indexes, ERD | reference |
| [architecture/api.md](./architecture/api.md) | look up an endpoint's roles, ownership, and error codes (human view of the contract) | reference |
| [architecture/auth-tokens.md](./architecture/auth-tokens.md) | understand signing keys, access claims, refresh rotation, reuse detection, revocation | explanation |
| [architecture/service-auth.md](./architecture/service-auth.md) | understand client credentials, scopes, the service guard, onboarding a new service client | explanation |
| [architecture/infrastructure.md](./architecture/infrastructure.md) | look up env vars, logging/redaction, error envelope, health, shutdown, rate limits | reference |
| [architecture/future.md](./architecture/future.md) | see what is deliberately deferred (events, MFA, social login, email change, AI client) | explanation |

## Decisions (append-only)
| ADR | Read it when you need to know why… | Lens |
|---|---|---|
| [adr/0001-no-orm-knex-raw-sql.md](./adr/0001-no-orm-knex-raw-sql.md) | there is no ORM and migrations are raw SQL | explanation |
| [adr/0002-asymmetric-jwt-rotating-refresh.md](./adr/0002-asymmetric-jwt-rotating-refresh.md) | tokens are EdDSA JWTs verified locally, refresh rotates, and the 15-min residual window is accepted | explanation |
| [adr/0003-argon2id-password-hashing.md](./adr/0003-argon2id-password-hashing.md) | passwords use argon2id with a bcrypt legacy fallback | explanation |

## Contract (source of truth — prose above derives from it)
| Contract | Defines | Lens |
|---|---|---|
| [contracts/openapi.yaml](../contracts/openapi.yaml) | the whole HTTP API: public `/api/*`, `/.well-known/jwks.json`, internal `/internal/*`; roles (`x-roles`), ownership (`x-ownership`), scopes (`x-scope`), error codes | reference |

No AsyncAPI contract: MVP is HTTP-only. Planned events are listed under `x-future-events` in the
contract and in [architecture/future.md](./architecture/future.md).

## Modules
Module docs (`brainstorm.md`, `spec.md`, `tasks.md`, `manual-qa.md`, `reviews/`) appear under
`docs/<module>/` as the workflow creates them (`/brainstorm` creates the folder). None exist yet;
add a row here for each module when it is started.

---
_Cross-service questions (who calls us, Care's contract, data ownership, glossary, PRD) → the hub:
`../vcare-hub/INDEX.md` (on GitHub: [OmarRedaX/Vcare](https://github.com/OmarRedaX/Vcare/blob/main/INDEX.md)).
Do not clone another service just to read its docs._
