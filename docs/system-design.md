---
title: Identity Service — System Design
owner: identity-team
service: identity-service
status: draft
diataxis: explanation
last_verified: 2026-09-15
tags: [system-design, architecture, router, identity]
related: [overview, data-model, api, auth-tokens, service-auth, infrastructure, future, design-baseline, capacity, deployment]
---

# System Design — identity-service

This page is the **router**. Architecture is sharded — one document per concern. Load the one you need.
`/system-design <topic>` adds or refines shards here and records decisions as ADRs.

| Section | Read it when you need to… | Lens |
|---|---|---|
| [architecture/design-baseline.md](./architecture/design-baseline.md) | see the 2026-09-15 system-design outcome: requirement gaps and decisions (D1–D17), target API surface, data-model delta, and the pending contract / `CLAUDE.md` changes | explanation |
| [architecture/capacity.md](./architecture/capacity.md) | derive Identity's load, compute, database, storage, and Redis sizing from the hub's shared assumptions; Identity's 10× check | explanation |
| [architecture/deployment.md](./architecture/deployment.md) | see Identity's runtime components, availability targets, release specifics, bottlenecks with mitigations, metrics and alerts | explanation |
| [architecture/overview.md](./architecture/overview.md) | see the container shape (public vs internal listener, worker, Postgres, Redis, email port), module map, layering, request pipeline | explanation |
| [architecture/data-model.md](./architecture/data-model.md) | look up tables, columns, constraints, partial indexes and the query each serves, ERD | reference |
| [architecture/api.md](./architecture/api.md) | look up endpoints by tag with roles, ownership, error codes (mirrors the current contract; pending changes in design-baseline) | reference |
| [architecture/auth-tokens.md](./architecture/auth-tokens.md) | understand EdDSA keys and rotation, access claims, refresh rotation, grace window and reuse detection, revocation paths | explanation |
| [architecture/service-auth.md](./architecture/service-auth.md) | understand client credentials, scopes, the service guard, onboarding a service client | explanation |
| [architecture/infrastructure.md](./architecture/infrastructure.md) | look up env vars, logging and redaction, error envelope, request id, health, shutdown, rate limits | reference |
| [architecture/future.md](./architecture/future.md) | see deferred work (events, MFA and admin provisioning, PII erasure, social login, email change, AI service client) | explanation |

**Source of truth for the API is [`contracts/openapi.yaml`](../contracts/openapi.yaml).**
`architecture/api.md` mirrors it; when they disagree the contract wins and the prose is stale.
Binding rules are in `CLAUDE.md`; when `CLAUDE.md` and the contract disagree, the contract wins and
the discrepancy is flagged. The 2026-09-15 baseline's `CLAUDE.md` edits are applied; its **contract changes are
approved but not yet applied** — see [design-baseline.md](./architecture/design-baseline.md) section 4.

Decisions: [adr/](./adr/) — 0001 no ORM · 0002 asymmetric JWT + rotating refresh · 0003 argon2id ·
0004 rejected accounts can sign in · 0005 refresh grace window · 0006 email-first registration ·
0007 outbox + worker · 0008 Redis Tier 2 fallback limiter · 0009 availability and recovery targets ·
0010 manual admin provisioning and role policies · 0011 PII retained on soft delete ·
0012 doctor status only via Care · 0013 log-derived metrics · 0014 health liveness/readiness.
Platform decisions from this design live in the hub: ADR 0005 single-origin edge, 0006 doctor status via Care,
0007 managed container platform.

Per-module detail (brainstorm, spec, tasks, QA, reviews) lives under `docs/<module>/` once the workflow
creates it. The hub-facing summary is [service-card.md](./service-card.md). Start at [INDEX.md](./INDEX.md).
Platform-scope architecture lives **only** in the hub (hub ADR 0008), starting at `../vcare-hub/INDEX.md`: the
platform overview and C4 views (`architecture/overview.md`), deployment topology (`deployment.md`), shared capacity
assumptions and sizing roll-up (`capacity.md`), integration cases (`landscape.md`), and data ownership.
