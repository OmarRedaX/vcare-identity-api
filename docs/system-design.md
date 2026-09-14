---
title: Identity Service — System Design
owner: identity-team
service: identity-service
status: draft
diataxis: explanation
last_verified: 2026-09-14
tags: [system-design, architecture, router, identity]
related: [overview, data-model, api, auth-tokens, service-auth, infrastructure, future]
---

# System Design — identity-service

This page is the **router**. Architecture is sharded — one document per concern. Load the one you need.
`/system-design <topic>` adds or refines shards here and records decisions as ADRs.

| Section | Read it when you need to… | Lens |
|---|---|---|
| [architecture/overview.md](./architecture/overview.md) | see the container shape (public vs internal listener, Postgres, Redis, email port), module map, layering, request pipeline | explanation |
| [architecture/data-model.md](./architecture/data-model.md) | look up tables, columns, constraints, partial indexes and the query each serves, ERD | reference |
| [architecture/api.md](./architecture/api.md) | look up endpoints by tag with roles, ownership, error codes | reference |
| [architecture/auth-tokens.md](./architecture/auth-tokens.md) | understand EdDSA keys and rotation, access claims, refresh rotation and reuse detection, revocation paths | explanation |
| [architecture/service-auth.md](./architecture/service-auth.md) | understand client credentials, scopes, the service guard, onboarding a service client | explanation |
| [architecture/infrastructure.md](./architecture/infrastructure.md) | look up env vars, logging and redaction, error envelope, request id, health, shutdown, rate limits | reference |
| [architecture/future.md](./architecture/future.md) | see deferred work (events, MFA, social login, email change, AI service client) | explanation |

**Source of truth for the API is [`contracts/openapi.yaml`](../contracts/openapi.yaml).**
`architecture/api.md` mirrors it; when they disagree the contract wins and the prose is stale.
Binding rules are in `CLAUDE.md`; when `CLAUDE.md` and the contract disagree, the contract wins and
the discrepancy is flagged.

Decisions: [adr/](./adr/) — 0001 no ORM, 0002 asymmetric JWT + rotating refresh, 0003 argon2id.
Per-module detail (brainstorm, spec, tasks, QA, reviews) lives under `docs/<module>/` once the workflow
creates it. The hub-facing summary is [service-card.md](./service-card.md). Start at [INDEX.md](./INDEX.md).
Cross-service architecture (C4 landscape, data ownership) lives in the hub: `../vcare-hub/INDEX.md`.
