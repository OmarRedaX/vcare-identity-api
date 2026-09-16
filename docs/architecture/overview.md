---
title: Identity Service — Architecture Overview
owner: identity-team
service: identity-service
status: draft
diataxis: explanation
last_verified: 2026-09-15
tags: [architecture, overview, layering, middleware]
related: [system-design, data-model, api, auth-tokens, service-auth, infrastructure, deployment, design-baseline]
---

# Architecture Overview

Identity owns **who someone is and whether they may act** — nothing else. It is **Tier 1**: when it is
down nobody can log in or refresh, so the hot paths (login, refresh, JWKS, `/internal/users`) stay small,
fast, and free of outbound calls. Care and the future AI service authenticate against it without touching
its database; they verify user access tokens locally with the published JWKS.

## 1. Container shape

One Node.js process (horizontally scalable, stateless) exposes **two HTTP listeners**:

```
                 Internet / web clients                       vcare private network
                          │ HTTPS                                      │
                          ▼                                            │
                 ┌──────────────────┐                      ┌───────────┴───────────┐
                 │  Public ingress  │  (never routes       │ care-service          │
                 │  (TLS, LB)       │   /internal)         │ future ai-service     │
                 └────────┬─────────┘                      └───────────┬───────────┘
                          │                                            │ service token
┌─────────────────────────┼────────────────────────────────────────────┼──────────────┐
│ identity-service        ▼                                            ▼              │
│  ┌───────────────────────────────────┐        ┌───────────────────────────────────┐ │
│  │ Public listener  PORT=3000        │        │ Internal listener INTERNAL_PORT=3100│ │
│  │ app.ts  → routes.ts               │        │ internal-app.ts → internal-routes.ts│ │
│  │ /api/auth/*  /api/users/*         │        │ bound to private interface only    │ │
│  │ /api/health                       │        │ /internal/auth/token               │ │
│  │ /.well-known/jwks.json            │        │ /internal/users  /internal/users/:id/status │
│  └───────────────┬───────────────────┘        │ /internal/health                   │ │
│                  │                            └───────────────┬───────────────────┘ │
│                  └──────────────┬─────────────────────────────┘                     │
│                                 ▼                                                   │
│        app/<module> services ─ repositories ─ lib/ (auth, rbac, idempotency, …)     │
└──────────────┬──────────────────────────┬──────────────────────────┬────────────────┘
               ▼                          ▼                          ▼ (async, outside request)
      ┌─────────────────┐        ┌─────────────────┐        ┌─────────────────────┐
      │ PostgreSQL      │        │ Redis           │        │ Email provider      │
      │ identity DB     │        │ rate limits,    │        │ via lib/email port  │
      │ (single writer) │        │ idempotency     │        │ (verification/reset)│
      └─────────────────┘        └─────────────────┘        └─────────────────────┘
```

| Element | Role | Notes |
|---|---|---|
| Public listener | end-user and admin API, JWKS, public health | behind ingress with TLS; CORS allowlist; `Cache-Control: no-store` on `/api/auth/*` |
| Internal listener | service-to-service API | binds to the private interface; ingress never routes `/internal`; a public router never imports an internal controller |
| PostgreSQL | all durable identity state | Identity is the single writer; no other service connects to it |
| Redis | sliding-window rate limits, idempotency records (24 h) | not a source of truth; **Tier 2** — its loss degrades limits, never availability (ADR 0008) |
| Worker (`identity-worker`) | outbox email delivery and scheduled purges | same image, `src/worker.ts`, separate deployment; claims `outbox_jobs` with `SKIP LOCKED` (ADR 0007) |
| Email port | registration codes, account-exists notices, password-reset emails | `lib/email` port + provider adapter; used **only by the worker**; never blocks or fails a request |

Identity's runtime components, scaling, and SLOs: [deployment.md](./deployment.md). Where Identity sits in the
platform (C4 views, edge, private network, other services): hub `architecture/overview.md` and `deployment.md`.

Signing keys are loaded from the `JWT_PRIVATE_KEYS` secret at boot; token verification is local
(no database hit) — see [auth-tokens.md](./auth-tokens.md).

## 2. Module map

Modules are created by the workflow (`/brainstorm` → … → `/update-docs`); none exist yet. The planned
bounded contexts under `src/app/<module>/`:

| Module | Listener | Owns | Tables written |
|---|---|---|---|
| `auth` | public | register start/complete, login, refresh, logout, forgot/reset/change password, `GET/PATCH /api/auth/me` (baseline 2026-09-15; the current contract still has register, verify-email, resend-verification) | `users` (create, profile fields, password), `refresh_tokens`, `registration_challenges`, `password_resets`, `outbox_jobs` (insert) |
| `outbox` | worker | claim, send, retry, dead-letter jobs; scheduled purges | `outbox_jobs`, hash/expiry columns of `registration_challenges` and `password_resets` |
| `users` | public | admin listing/lookup, admin status change, status history writes | `users.status`, `user_status_changes` |
| `sessions` | public | session listing and revocation by family; revocation primitives used by `auth` and `users` | `refresh_tokens` (revoke) |
| `internal-users` | internal | batch summary lookup, Care-driven status change | via `users` and `sessions` services |
| `service-auth` | internal | client-credentials exchange, service token issuance | `service_clients` (read, `last_used_at`) |

Cross-module calls go through **services**, never another module's repository. For example
`internal-users` calls `UsersService.changeStatus(...)`, which calls `SessionsService.revokeAllForUser(...)`
inside the transaction it owns.

Shared infrastructure lives in `src/lib/`: `auth/` (jwt, jwks, user-guard, service-guard), `rbac/`
(deny-by-default `authorize`), `request-id/`, `config/` (zod env), `di/`, `error/`, `http/` (response,
pagination), `idempotency/`, `rate-limit/`, `knex/`, `redis/`, `logger/`, `email/`, `validation/`.
Pure helpers (time math, random tokens, sha256) live in `src/pkg/utils/`.

## 3. Layering

```
app/  → may import lib/, pkg/
lib/  → may import pkg/, config; must NOT import app/<module>/* (only DI tokens at boot)
pkg/  → pure functions; NO imports from lib/ or app/, NO env, NO singletons
```

Inside a module: `routes.ts` → `controller` (validate → call service → `sendSuccess`) → `service`
(business rules, transactions, `AppError`) → `repository` (exported functions, explicit column lists,
`whereNull('deleted_at')`) → Postgres. Controllers return response DTOs only; no DTO ever carries a
password hash, token hash, or secret.

## 4. Request pipeline

Every request on either listener passes through the same ordered chain. Per-route middleware
(guard → authorize → idempotency) is declared in the module's `routes.ts`.

| # | Stage | Where | Behaviour |
|---|---|---|---|
| 1 | `helmet` (+ CORS on public) | app-level | security headers; CORS allowlist from `CORS_ORIGINS`, credentials only for listed origins |
| 2 | request id | `lib/request-id` | adopt a UUID `X-Request-Id` or generate one; set `req.requestId`; echo on the response; bind to the logger |
| 3 | JSON body parser | app-level | size-limited; form parser only on `/internal/auth/token` |
| 4 | rate limit | `lib/rate-limit` | Redis sliding window per route key (IP, IP+email, email, family, client) → `429 RateLimited` + `Retry-After` |
| 5 | guard | `lib/auth/user-guard` or `service-guard` | verify signature (EdDSA, `kid` from JWKS set), `iss`, `aud`, `exp`, `typ`; set `req.auth`; refresh routes read the `vcare_rt` cookie instead |
| 6 | authorize | `lib/rbac/authorize(policy)` | deny by default: role ∈ policy roles **and** ownership predicate **and** account-state requirement; else `403` (or `404` where existence would leak) |
| 7 | idempotency | `lib/idempotency` | required on register, optional on other POSTs; replay or `422 IdempotencyConflict` |
| 8 | handler | controller → service → repository | `validateBody` / `validateQuery` → `400 ValidationFailed`; service throws `AppError` |
| 9 | error envelope | `lib/error/errorHandler` | the only producer of `{ success: false, error: { code, message, details?, requestId } }`; unknown errors → `500 InternalError` with no internals |

Public routes that need no principal (register, login, verify, forgot/reset, JWKS, health) skip stage 5
but still declare a `public` policy at stage 6 — a route without `authorize(...)` fails closed.

## 5. Consistency and performance posture

- Every state change that must be atomic (status + revocation + history; refresh rotation; password
  reset + revocation) runs in **one service-owned transaction**.
- Internal endpoints make no outbound calls; `/internal/users` is one `= ANY($1)` query.
- Budgets (p95): refresh < 50 ms · `/internal/users` (100 ids) < 50 ms · JWKS < 10 ms (cached) ·
  login < 250 ms including argon2 · other writes < 200 ms.
- Email sending and expired-token cleanup run outside the request.
