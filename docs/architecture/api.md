---
title: Identity Service — API (human view of the contract)
owner: identity-team
service: identity-service
status: draft
diataxis: reference
last_verified: 2026-09-15
tags: [architecture, api, endpoints, rbac, error-codes]
related: [system-design, auth-tokens, service-auth, infrastructure, design-baseline]
---

# API

This page **derives from [`contracts/openapi.yaml`](../../contracts/openapi.yaml)** — the source of truth.
If this page and the contract disagree, the contract wins and this page is stale; fix it with `/update-docs`.

> **Pending (approved 2026-09-15, not yet in the contract):** registration becomes `register/start` +
> `register/complete` and `verify-email` / `resend-verification` are removed (ADR 0006); `rejected` accounts can
> log in and refresh (ADR 0004); refresh has a 10 s grace window that returns `RefreshTokenInvalid` without
> revoking the family or clearing the cookie (ADR 0005); `PATCH /api/users/{id}/status` refuses doctor targets
> (ADR 0012); health splits into `…/health/live` and `…/health/ready` (ADR 0014). Full list:
> [design-baseline.md](./design-baseline.md) → Required contract changes. This page is updated when the
> contract changes.
Per-field request/response schemas are in the contract; this page shows roles, ownership, and errors.

## Conventions
| Topic | Rule |
|---|---|
| Base paths | public `/api/*` and `/.well-known/jwks.json` on `PORT` (local 3000); `/internal/*` on `INTERNAL_PORT` (local 3100), network-isolated. Care runs locally on 3001 / 3101 |
| Success | `{ "success": true, "data": …, "meta"?: … }` (`meta` only on lists) |
| Error | `{ "success": false, "error": { "code", "message", "details"?: [{ "field", "issue" }], "requestId" } }` |
| Exceptions | `/.well-known/jwks.json` returns a bare JWK Set; `/api/health` and `/internal/health` return a bare `{ status, checks }` object |
| Request id | `X-Request-Id` (UUID) accepted or generated; returned on every response |
| Pagination | `?cursor=&limit=` (1..100, default 20); `meta: { nextCursor, hasMore, count }` |
| Idempotency | `Idempotency-Key` (UUID) **required** on `POST /api/auth/register`, optional on other POSTs; 24 h; same key + different body → `422 IdempotencyConflict` |
| IDs | integers (int64) |
| Auth transport | user access token `Authorization: Bearer`; refresh token only in cookie `vcare_rt` (`Path=/api/auth`); service token `Authorization: Bearer` on `/internal/*` |
| Caching | `Cache-Control: no-store` on every `/api/auth/*` response and the service token response |

Every error response also carries `X-Request-Id`. Every route may return `500 InternalError`; it is
omitted from the tables below.

## Tag: auth
| Method + path | Roles (`x-roles`) | Ownership | Success | Error codes | Rate limit |
|---|---|---|---|---|---|
| `POST /api/auth/register` | public | none | `201` `User` | `ValidationFailed` 400 · `Conflict` 409 · `IdempotencyConflict` 422 · `RateLimited` 429 | 5/h per IP |
| `POST /api/auth/login` | public | none | `200` `LoginResponse` + `Set-Cookie: vcare_rt` | `ValidationFailed` 400 · `InvalidCredentials` 401 · `AccountSuspended` / `AccountRejected` 403 · `IdempotencyConflict` 422 · `RateLimited` 429 | 5/min per IP+email, 20/min per IP |
| `POST /api/auth/refresh` | patient, doctor, admin (refresh cookie) | refresh-family | `200` `AccessTokenResponse` + rotated `Set-Cookie` | `RefreshTokenInvalid` / `RefreshTokenReused` 401 · `AccountSuspended` / `AccountRejected` 403 · `RateLimited` 429 | 30/min per family |
| `POST /api/auth/logout` | patient, doctor, admin (refresh cookie, optional) | refresh-family | `204` + clearing `Set-Cookie` | — (always 204) | — |
| `POST /api/auth/verify-email` | public | none | `204` | `ValidationFailed` 400 (incl. invalid/expired/used token, `field: token`) · `IdempotencyConflict` 422 · `RateLimited` 429 | 10/h per IP |
| `POST /api/auth/resend-verification` | public | none | `204` (always) | `ValidationFailed` 400 · `IdempotencyConflict` 422 · `RateLimited` 429 | 3/h per email |
| `POST /api/auth/forgot-password` | public | none | `204` (always) | `ValidationFailed` 400 · `IdempotencyConflict` 422 · `RateLimited` 429 | 3/h per email |
| `POST /api/auth/reset-password` | public | none | `204` | `ValidationFailed` 400 (incl. invalid/expired/used token, `field: token`) · `IdempotencyConflict` 422 · `RateLimited` 429 | 10/h per IP |
| `POST /api/auth/change-password` | patient, doctor, admin | self | `204` | `ValidationFailed` 400 · `Unauthorized` / `TokenExpired` / `InvalidCredentials` (wrong current password) 401 · `AccountSuspended` / `AccountRejected` 403 · `IdempotencyConflict` 422 | — |
| `GET /api/auth/me` | patient, doctor, admin | self | `200` `User` | `Unauthorized` / `TokenExpired` 401 · `AccountSuspended` / `AccountRejected` 403 | — |
| `PATCH /api/auth/me` | patient, doctor, admin | self | `200` `User` | `ValidationFailed` 400 (incl. any of `email`, `role`, `status`) · `Unauthorized` / `TokenExpired` 401 · `AccountSuspended` / `AccountRejected` 403 | — |

Notes
- Register accepts `role` `patient` or `doctor` only. Patients start `active`, doctors `pending`; neither is
  verified. Registration does not log in.
- Login: unknown email and wrong password are indistinguishable (`InvalidCredentials`, equalized timing).
  `pending` doctors can log in; their token carries `status=pending`.
- Refresh: presenting a rotated token revokes the whole family → `RefreshTokenReused`. Any 401/403 clears the cookie.
- Change-password revokes every other family (keeps the family of the cookie sent with the request).
  Reset-password revokes all families.
- `PATCH /api/auth/me` accepts only `fullName`, `phone`, `avatarUrl`, `timezone`, `locale`.

## Tag: users (admin)
| Method + path | Roles | Ownership | Success | Error codes |
|---|---|---|---|---|
| `GET /api/users` | admin (active) | none | `200` `User[]` + `PaginationMeta` | `ValidationFailed` 400 · `Unauthorized` / `TokenExpired` 401 · `Forbidden` / `AccountSuspended` / `AccountRejected` 403 |
| `GET /api/users/{id}` | admin (active) | none | `200` `User` | `ValidationFailed` 400 · `Unauthorized` / `TokenExpired` 401 · `Forbidden` / `AccountSuspended` / `AccountRejected` 403 · `NotFound` 404 |
| `PATCH /api/users/{id}/status` | admin (active) | none; not self; not another admin | `200` `StatusChangeResponse` | `ValidationFailed` 400 · `Unauthorized` / `TokenExpired` 401 · `Forbidden` 403 (incl. self / admin target) · `NotFound` 404 · `InvalidStatusTransition` 409 |
| `GET /api/users/{id}/sessions` | admin (active) | none | `200` `Session[]` + `PaginationMeta` | `ValidationFailed` 400 · `Unauthorized` / `TokenExpired` 401 · `Forbidden` 403 · `NotFound` 404 |
| `DELETE /api/users/{id}/sessions` | admin (active) | none | `204` | `ValidationFailed` 400 · `Unauthorized` / `TokenExpired` 401 · `Forbidden` 403 · `NotFound` 404 |

Notes
- `GET /api/users` filters: `role`, `status`, `email` (exact, case-insensitive). Sort fixed at `created_at DESC, id DESC`.
- Admin status body `{ status: "active" | "suspended", reason }`. Allowed: `active → suspended`, `suspended → active`.
  Same status again → 200, no history row. Reinstatement (`suspended → active`) exists **only** on this
  admin route and is not propagated to Care in MVP.
- **Known gap:** this route does not notify Care. Two mitigations apply until `user.status_changed` exists
  ([future.md](./future.md)): (1) the admin console routes doctor suspension through Care
  (`PATCH /admin/doctors/:id/suspend` → internal status route); (2) Care reads `status` from batch hydration
  and hides non-active doctors from search when that data is fresh.

## Tag: keys
| Method + path | Roles | Ownership | Success | Error codes |
|---|---|---|---|---|
| `GET /.well-known/jwks.json` | public | none | `200` JWK Set (`kty=OKP`, `crv=Ed25519`, `alg=EdDSA`, `use=sig`, `kid`), `Cache-Control: public, max-age=300` | — |

## Tag: health
| Method + path | Roles | Success | Failure |
|---|---|---|---|
| `GET /api/health` | public | `200 { status: "ok", checks: { database: "up", redis: "up" } }` | `503 { status: "degraded", checks }` |
| `GET /internal/health` | public (private network only) | same | same |

## Tag: service-auth (internal listener)
| Method + path | Roles | Scope | Success | Error codes | Rate limit |
|---|---|---|---|---|---|
| `POST /internal/auth/token` | service (client credentials in body) | none | `200` `ServiceTokenResponse` `{ access_token, token_type: "Bearer", expires_in: 300, scope }` | `ValidationFailed` 400 · `InvalidCredentials` 401 (unknown/disabled client or wrong secret) · `InsufficientScope` 403 (scope or audience not allowed) · `RateLimited` 429 | 60/min per client |

Body (JSON or form-encoded): `grant_type=client_credentials`, `client_id`, `client_secret`, `scope`
(space-separated), `audience`. See [service-auth.md](./service-auth.md).

## Tag: internal-users (internal listener)
| Method + path | Roles | Scope | Success | Error codes |
|---|---|---|---|---|
| `GET /internal/users?ids=1,2,3` | service | `users:read` | `200` `UserSummary[]` | `ValidationFailed` 400 (0 or > 100 ids, non-integer) · `ServiceTokenRequired` 401 (incl. any user token) · `InsufficientScope` 403 |
| `PATCH /internal/users/{id}/status` | service | `users:status:write` | `200` `StatusChangeResponse` `{ id, status, updatedAt }` | `ValidationFailed` 400 · `ServiceTokenRequired` 401 · `InsufficientScope` 403 · `NotFound` 404 · `InvalidStatusTransition` 409 |

Notes
- `/internal/users`: unknown and soft-deleted ids are omitted; `UserSummary` is
  `{ id, fullName, avatarUrl, role, status, timezone, locale }` — never email or phone.
- Internal status body `{ status: "active" | "rejected" | "pending" | "suspended", reason, actorUserId }`.
  Allowed: `pending → active|rejected` (Case 1), `rejected → pending` (Care re-opened a rejected
  application), `active → suspended` (Case 3). `suspended → active` is **not** allowed here (admin-only, public API).
- Setting the current status again → 200 no-op (no history row; already `suspended` still ensures no live
  refresh tokens). Every other pair → `409 InvalidStatusTransition`, which callers treat as **non-retryable**
  — e.g. Case 3 on a target that is not `active` signals drift, so Care alerts instead of retrying.
- Entering `suspended` or `rejected` revokes all refresh-token families in the same transaction as the update
  and the history row.
- `UserSummary.fullName` is the provider field name; Care renames it to `displayName` on its side.

## Error code catalogue
| Code | HTTP | Returned by |
|---|---|---|
| `ValidationFailed` | 400 | every route with a body, path, or query input |
| `Unauthorized` | 401 | bearer routes with a missing/invalid token |
| `TokenExpired` | 401 | bearer routes with an expired token |
| `InvalidCredentials` | 401 | login, change-password (current password), `/internal/auth/token` |
| `RefreshTokenInvalid` | 401 | refresh |
| `RefreshTokenReused` | 401 | refresh |
| `EmailNotVerified` | 403 | not returned by Identity routes in MVP; reserved in the shared catalogue (Care enforces verified email via the `ev` claim) |
| `AccountPending` | 403 | not returned by Identity routes in MVP (Identity has no doctor-only action); reserved in the shared catalogue |
| `AccountSuspended` | 403 | login, refresh, bearer routes whose token carries `status=suspended` |
| `AccountRejected` | 403 | login, refresh, bearer routes whose token carries `status=rejected` |
| `Forbidden` | 403 | admin routes (wrong role, self/admin target) |
| `ServiceTokenRequired` | 401 | `/internal/users`, `/internal/users/{id}/status` |
| `InsufficientScope` | 403 | internal routes; `/internal/auth/token` |
| `NotFound` | 404 | `/api/users/{id}*`, `/internal/users/{id}/status` |
| `Conflict` | 409 | register (email already registered among live accounts) |
| `InvalidStatusTransition` | 409 | both status routes |
| `IdempotencyConflict` | 422 | POST routes with `Idempotency-Key` |
| `RateLimited` | 429 | rate-limited routes (with `Retry-After`) |
| `InternalError` | 500 | any route |
