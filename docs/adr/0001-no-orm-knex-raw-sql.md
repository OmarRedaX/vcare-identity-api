---
title: "ADR 0001: No ORM — Knex query builder + raw-SQL migrations"
owner: identity-team
service: identity-service
status: accepted
date: 2026-09-14
diataxis: explanation
last_verified: 2026-09-14
tags: [adr, decision, database, knex, postgresql]
related: [system-design, data-model]
---

# ADR 0001 — No ORM; Knex query builder + raw-SQL migrations

- **Status:** Accepted • **Date:** 2026-09-14 • **Deciders:** identity-team

## Context
Identity is Tier 1 and its hot paths have tight budgets: refresh p95 < 50 ms, `/internal/users` with 100
ids p95 < 50 ms, login < 250 ms including argon2. Its security-critical writes are multi-statement units
that must be atomic and precisely locked: refresh rotation (`SELECT … FOR UPDATE`, insert, revoke), status
change + family revocation + history row, password reset + revocation. The schema relies on PostgreSQL
features — `CITEXT`, partial unique indexes on live rows, `CHECK` constraints for enum-like columns,
`TEXT[]`, `= ANY($1)` batching — that ORMs model poorly or hide. Every query must be visible, use an
explicit column list (a response must never accidentally carry `password_hash` or `token_hash`), and be
`EXPLAIN`-checked.

## Decision
Use **Knex over `pg`** as a query builder, with **raw-SQL migrations** (`knex.raw` in `up`/`down`; the
schema builder is forbidden). Repositories are exported **functions** taking `conn: Knex = db`, with an
explicit `<MODULE>_COLUMNS` list, a private `toEntity(row)`, and `whereNull('deleted_at')` on reads.
Services own transactions and pass `trx` down; transactions never nest. All ORMs (Prisma, TypeORM,
Sequelize, Drizzle, Kysely, MikroORM) are forbidden (CLAUDE.md → Tech stack; → Database rules).

## Consequences
- ➕ Every statement on a hot path is visible in code and reviewable against its index.
- ➕ Locking and transaction boundaries for rotation, revocation, and status history are explicit.
- ➕ Full access to PostgreSQL features (partial indexes, `CITEXT`, `CHECK`, arrays) with migrations that
  read exactly like the schema in [data-model.md](../architecture/data-model.md).
- ➕ Explicit column lists make secret leakage through `SELECT *` structurally impossible.
- ➖ More boilerplate: column constants, `toEntity` mappers, hand-written `down` migrations.
- ➖ No generated types from the schema; entity and row mapping is maintained by hand and covered by
  integration tests against a real database.
- ➖ Contributors used to ORMs need the `write-migration` skill and review discipline.

## Alternatives considered
- **Prisma** — rejected: generated SQL is opaque, partial unique indexes and `CITEXT` need escape hatches,
  its migration engine owns the schema, and it adds a query-engine layer to the latency budget.
- **TypeORM / MikroORM / Sequelize** — rejected: decorator-based entities (forbidden), lazy relations
  invite N+1, implicit transaction handling.
- **Drizzle / Kysely (typed query builders)** — rejected for consistency with the platform baseline
  (care-service uses the same stack) and to avoid a second query abstraction; typed builders remain an
  option only via a superseding ADR.
- **Raw `pg` without Knex** — rejected: loses the pooled connection management, transaction helper, and
  migration runner Knex provides for little gain.
