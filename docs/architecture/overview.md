---
title: Identity Service — Architecture Overview
owner: identity-team
service: identity-service
status: draft
diataxis: explanation
last_verified: 2026-10-08
tags: [architecture, overview, layering, middleware]
related: [system-design, data-model, api, auth-tokens, service-auth, infrastructure, deployment, design-baseline, foundation-spec]
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
│  │ /api/health/live|ready            │        │ /internal/auth/token               │ │
│  │ /.well-known/jwks.json            │        │ /internal/users  /internal/users/:id/status │
│  └───────────────┬───────────────────┘        │ /internal/health/live|ready        │ │
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
| Public listener | end-user and admin API, JWKS, public health | `src/server.ts` binds `PORT` on all interfaces; behind ingress with TLS; CORS allowlist in local development only; `Cache-Control: no-store` on `/api/auth/*` and health |
| Internal listener | service-to-service API, internal health | binds `INTERNAL_HOST:INTERNAL_PORT` (private interface); ingress never routes `/internal`; a public router never imports an internal controller (ESLint-enforced) |
| PostgreSQL | all durable identity state | Identity is the single writer; no other service connects to it |
| Redis | sliding-window rate limits, idempotency records (24 h) | not a source of truth; **Tier 2** — its loss degrades limits, never availability (ADR 0008) |
| Worker (`identity-worker`) | outbox email delivery and scheduled purges | same image, `src/worker.ts`, separate deployment; claims `outbox_jobs` with `SKIP LOCKED` (ADR 0007). As built (2026-09-16): a poll loop with an empty tick; job handlers arrive with the outbox module |
| Email port | registration codes, account-exists notices, password-reset emails | `lib/email` port + provider adapter; used **only by the worker**; never blocks or fails a request |

Identity's runtime components, scaling, and SLOs: [deployment.md](./deployment.md). Where Identity sits in the
platform (C4 views, edge, private network, other services): hub `architecture/overview.md` and `deployment.md`.

Signing keys are loaded from the `JWT_PRIVATE_KEYS` secret at boot; token verification is local
(no database hit) — see [auth-tokens.md](./auth-tokens.md).

## 2. Module map

Modules are created by the workflow (`/brainstorm` → … → `/update-docs`). As of 2026-09-16 the `foundation`
module is built: it contributes the entrypoints, `src/lib/`, and the `health` module. The business bounded contexts
under `src/app/<module>/` are still planned:

| Module | Listener | Owns | Tables written |
|---|---|---|---|
| `health` (**built**, foundation) | both | liveness and readiness probes (ADR 0014); no entity, request DTO, errors, or policy — the documented probe exception | none |
| `auth` | public | register start/complete, login, refresh, logout, forgot/reset/change password, `GET/PATCH /api/auth/me` | `users` (create, profile fields, password), `refresh_tokens`, `registration_challenges`, `password_resets`, `outbox_jobs` (insert) |
| `outbox` | worker | claim, send, retry, dead-letter jobs; scheduled purges | `outbox_jobs`, hash/expiry columns of `registration_challenges` and `password_resets` |
| `users` | public | admin listing/lookup, admin status change, status history writes | `users.status`, `user_status_changes` |
| `sessions` | public | session listing and revocation by family; revocation primitives used by `auth` and `users` | `refresh_tokens` (revoke) |
| `internal-users` | internal | batch summary lookup, Care-driven status change | via `users` and `sessions` services |
| `service-auth` | internal | client-credentials exchange, service token issuance | `service_clients` (read, `last_used_at`) |

Cross-module calls go through **services**, never another module's repository. For example
`internal-users` calls `UsersService.changeStatus(...)`, which calls `SessionsService.revokeAllForUser(...)`
inside the transaction it owns.

Entrypoints (built): `src/server.ts` (both listeners + graceful shutdown), `src/app.ts` and `src/internal-app.ts`
(app-level middleware), `src/routes.ts` and `src/internal-routes.ts` (module router mounts), `src/bootstrap.ts` (the
only DI registration), `src/worker.ts` (worker loop), `src/migrate.ts` (migration CLI).

Shared infrastructure lives in `src/lib/`. Built by the foundation: `config/` (zod env), `di/` (tokens; container
without registrations), `error/`, `logger/` (logger, redaction, request log), `request-id/`, `http/` (response
helpers, pagination, CORS, no-store, client IP, route capture), `lifecycle/` (shutdown flag, in-flight counter),
`validation/`, `knex/`, `redis/`, `idempotency/`, `rate-limit/`, `worker/` (loop runner), `types/`.
Planned: `auth/` (jwt, jwks, user-guard, service-guard), `rbac/` (deny-by-default `authorize`), `email/`, `outbox/`.
Pure helpers live in `src/pkg/utils/`: `time.ts` is built; random tokens and sha256 (`crypto.ts`) are planned.

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

Every request on either listener passes through the same ordered chain. Stages 1–6 and 12–13 are app-level and
built (`src/app.ts`, `src/internal-app.ts`); stages 7–11 are per-route middleware declared in the module's
`routes.ts` (the rate-limit and idempotency middleware exist; guards and `authorize` are planned).

| # | Stage | Where | Behaviour |
|---|---|---|---|
| 1 | in-flight tracker | `lib/lifecycle/inflight` | counts the request until `finish`/`close`; the count is logged if shutdown times out |
| 2 | request id | `lib/request-id` | adopt a single UUID `X-Request-Id` (lower-cased) or generate one; set `req.requestId`; echo on the response; bind to every log line |
| 3 | request log | `lib/logger/request-logger` | one `request_completed` line on finish (health routes only when ≥ 500) |
| 4 | `helmet` | app-level | security headers; HSTS on the public listener in production only |
| 5 | CORS | `lib/http/cors` — public listener, non-production only | exact-match allowlist from `CORS_ORIGINS`, credentials only for listed origins; preflight → `204` |
| 6 | JSON body parser | app-level | `application/json`, strict, 100 kb; a form parser only on `/internal/auth/token` (route-scoped `application/x-www-form-urlencoded`, 100 kb; as built) |
| 7 | rate limit | `lib/rate-limit` | Redis sliding window per route key (IP, IP+email, email, family, client) → `429 RateLimited` + `Retry-After`; in-process fallback or fail-open when Redis is down |
| 8 | guard (planned) | `lib/auth/user-guard` or `service-guard` | verify signature (EdDSA, `kid` from JWKS set), `iss`, `aud`, `exp`, `typ`; set `req.auth`; refresh routes read the `vcare_rt` cookie instead |
| 9 | authorize (planned) | `lib/rbac/authorize(policy)` | deny by default: role ∈ policy roles **and** ownership predicate **and** account-state requirement; else `403` (or `404` where existence would leak) |
| 10 | idempotency | `lib/idempotency` | required on `register/complete`, optional on other POSTs; replay, `422 IdempotencyConflict`, or `409 Conflict` while in flight; skipped when Redis is down |
| 11 | handler | controller → service → repository | `validateBody` / `validateQuery` / `validateParams` → `400 ValidationFailed`; service throws `AppError` |
| 12 | not found | `lib/error/errorHandler` → `notFoundHandler` | no route matched → `404 NotFound` |
| 13 | error envelope | `lib/error/errorHandler` | the only producer of `{ success: false, error: { code, message, details, requestId } }` (`details` always present); unknown errors → `500 InternalError` with no internals |

Public routes that need no principal (register start/complete, login, forgot/reset, JWKS) skip stage 8
but still declare a `public` policy at stage 9 — a route without `authorize(...)` fails closed. The health probes
are the one documented exception: no guard, no `authorize`, no rate limit, no idempotency (ADR 0014,
[foundation/spec.md](../foundation/spec.md) §3).

## 5. Consistency and performance posture

- Every state change that must be atomic (status + revocation + history; refresh rotation; password
  reset + revocation) runs in **one service-owned transaction**.
- Internal endpoints make no outbound calls; `/internal/users` is one `= ANY($1)` query.
- Budgets (p95): refresh < 50 ms · `/internal/users` (100 ids) < 50 ms · JWKS < 10 ms (cached) ·
  login < 250 ms including argon2 · other writes < 200 ms.
- Email sending and expired-token cleanup run outside the request.
