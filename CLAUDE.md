# CLAUDE.md — vcare Identity & Access Service (`identity-service`)

These rules are **binding** for every human and agent working in this repo. They are the production
baseline for the vcare platform, made stricter than the reference `playground-with-context`. This file
is **self-contained** — you do not need another repo's CLAUDE.md to follow it.

- **Source of intent:** the PRD at `../vcare-hub/product/prd.md`. **Source of truth for the API:** `contracts/openapi.yaml`.
- **Cross-service context:** the hub at `../vcare-hub` (start at its `INDEX.md`). Platform-scope docs — overview, deployment topology, capacity model, integration cases, data ownership — live **only** there; see "Doc placement — hub or service".
- **Citing this file:** always cite sections **by name** (e.g. "CLAUDE.md → Security rules"), never by number.
- **Architect trigger:** when the user says **"let's system design"** (or runs `/system-design <topic>`), run the `/system-design` command inline — see "Architect mode — /system-design".

> Status: AI setup only — **no application code exists yet**. Modules are created through the workflow
> (`/system-design` → `/brainstorm` → … → `/update-docs`). Do not scaffold `src/` outside that workflow.

When a rule here conflicts with your defaults, **this file wins**. When a rule here conflicts with
`contracts/openapi.yaml`, **the contract wins** and this file or the spec is stale — flag it.

---

## Mission of this service

Identity owns **who someone is and whether they may act**. Nothing else.

| Owns (single writer) | Never owns |
|---|---|
| Accounts (`users`): email, phone, password hash, full name, avatar, role, status, timezone, locale | Doctor profiles, credentials, verification documents (Care) |
| Authentication: login, logout, access tokens, rotating refresh tokens, sessions | Consultations, schedules, medical records (Care) |
| Email ownership proof at registration (6-digit code, ADR 0006), password reset, password change | The *decision* to approve/reject/suspend a doctor (Care decides; Identity applies the account state) |
| Account status: `pending`, `active`, `suspended`, `rejected` | Any clinical data, ever |
| Service clients and service tokens for service-to-service auth | |
| Account status history (who changed a status, when, why, from which service) | |

Identity is the **shared foundation**: Care, and the Phase-2 AI service, authenticate against it without
touching its database. Identity is **Tier 1** — if it is down, nobody can log in — so its hot paths
(login, refresh, JWKS, `/internal/users`) must be small, fast, and dependency-light.

Roles: `patient`, `doctor`, `admin`. Admins are never created by public registration: in MVP ops inserts the row
manually (`role='admin'`, unusable argon2id hash) and the admin sets their password through forgot/reset password
(ADR 0010; runbook → Create an admin account). A provisioning CLI and admin MFA are deferred.

---

## Tech stack (locked)

| Concern | Library / tool |
|---|---|
| Runtime | Node.js 24 LTS + TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`) |
| HTTP | `express` v5 |
| Request validation | `class-validator` + `class-transformer` (DTO classes) |
| Env validation | `zod` (env only) |
| DI | `tsyringe` with `Symbol.for()` tokens |
| DB | `knex` over `pg` — query builder + **raw-SQL migrations** |
| Cache / rate limit / idempotency | `ioredis` |
| JWT / JWKS | `jose` — **EdDSA (Ed25519)** signatures, `kid` per key |
| Password hashing | `argon2` (argon2id); `bcrypt` only to verify legacy hashes, then rehash |
| Security headers | `helmet` |
| Logging | custom structured JSON `Logger` |
| Testing | `jest` + `supertest` |
| IDs | `BIGSERIAL` primary keys, **exposed as numeric ids** (hub ADR 0004) |

**Forbidden:** every ORM (Prisma, TypeORM, Sequelize, Drizzle, Kysely, MikroORM), NestJS, GraphQL, gRPC,
tRPC, Passport, Auth0/Clerk/any hosted auth, `jsonwebtoken` (use `jose`), `moment`. Adding **any** new
runtime dependency requires an ADR in `docs/adr/` first.

---

## Folder structure and layering

```
src/
  app.ts                     # public express app (mounted under /api)
  internal-app.ts            # internal express app (mounted under /internal) — separate listener
  server.ts                  # bootstrap both listeners + graceful shutdown
  worker.ts                  # outbox worker entrypoint (email delivery, purges) — separate deployment (ADR 0007)
  bootstrap.ts               # DI registration (the only place that wires app/ into the container)
  migrate.ts                 # migration CLI (latest / rollback / status / make)
  routes.ts                  # mounts public module routers
  internal-routes.ts         # mounts internal module routers
  app/<module>/              # one folder per bounded context (auth, users, sessions, internal-users, service-auth, ...)
    controller/<module>.controller.ts
    service/<module>.service.ts
    repository/<module>.repo.ts
    entity/<module>.entity.ts
    dto/<module>.request.dto.ts
    dto/<module>.response.dto.ts
    enums.ts  errors.ts  types.ts  routes.ts  policies.ts
  lib/
    auth/        # jwt.ts (sign/verify), jwks.ts (key set + rotation), user-guard.ts, service-guard.ts
    rbac/        # authorize.ts (deny-by-default), types.ts
    request-id/  # X-Request-Id middleware
    config/      # env.ts (zod)
    di/          # container.ts, tokens.ts
    error/       # AppError.ts, errorHandler.ts (the one error envelope)
    http/        # response.ts, pagination/, cors.ts, no-store.ts, client-ip.ts
    lifecycle/   # shutdown/readiness state, in-flight request counter
    worker/      # loop runner for the worker (stop after the current tick)
    idempotency/ # Redis-backed idempotency middleware
    rate-limit/  # Redis sliding-window limiter
    knex/        # knex.ts, knexfile.ts
    redis/       # connection + health
    logger/      # logger.ts (redaction built in)
    email/       # email port + provider adapter (used only by the worker; never blocks a request)
    outbox/      # enqueue (inside the caller's transaction), claim with SKIP LOCKED, retry/dead-letter
    types/       # express.d.ts (req.auth, req.requestId)
    validation/  # validateBody / validateQuery
  pkg/
    utils/       # time.ts, crypto.ts (random tokens, sha256), string.ts — pure, framework-free
  migrations/
tests/
  unit/  integration/  setup.ts
```

**Layering (strict):**
```
app/  → may import lib/, pkg/
lib/  → may import pkg/, config; must NOT import app/<module>/* (only DI tokens at boot)
pkg/  → pure functions; NO imports from lib/ or app/, NO env, NO singletons
```
- Cross-module calls go through **services**, never another module's repository.
- `/internal/*` routers are mounted **only** on the internal listener (`INTERNAL_PORT`), which is not
  exposed through the public ingress. A public route must never import an internal controller.

---

## Naming conventions

**Files:** `kebab-case` (`refresh-token.repo.ts`); one class per file.
**TypeScript:** `PascalCase` classes/types/enums · `camelCase` variables/methods · `UPPER_SNAKE_CASE` constants and DI token names.
**Database:**
- Tables plural `snake_case` (`users`, `refresh_tokens`, `service_clients`); columns `snake_case`; booleans `is_*`.
- PK `id BIGSERIAL`; FK columns `BIGINT`.
- Constraints: `fk_<table>_<col>`, `uq_<table>_<cols>`, `chk_<table>_<what>`; indexes `idx_<table>_<cols>`.
- Timestamps: `created_at`, `updated_at`, `deleted_at`, `<verb>_at` — **always `TIMESTAMPTZ`**.
**Routes:** plural nouns, `PATCH` for partial updates, sub-resources for relations (`/users/:id/sessions`).
**Error codes:** `PascalCase`, stable forever once shipped (clients branch on them).

---

## Module file conventions

Every module under `src/app/<module>/` has the same skeleton.

1. **`entity/<module>.entity.ts`** — plain class, `constructor(data: Partial<X>)`, no decorators, no DB knowledge.
2. **`dto/<module>.request.dto.ts`** — `class-validator` classes; every field has an explicit validator;
   unknown properties are rejected (`forbidNonWhitelisted: true`). Validated via `validateBody(Dto, req.body)`.
3. **`dto/<module>.response.dto.ts`** — plain classes with `static from(entity)`. Controllers return
   **only** response DTOs — a response DTO never has a `passwordHash`, token hash, or secret field.
4. **`repository/<module>.repo.ts`** — exported **functions**, each taking `conn: Knex = db`, an explicit
   `<MODULE>_COLUMNS` list (never `SELECT *`), a private `toEntity(row)`, and `whereNull('deleted_at')`
   on every read unless the function name says `IncludingDeleted`.
5. **`service/<module>.service.ts`** — `@injectable()`; owns business rules and transactions; throws `AppError` instances.
6. **`controller/<module>.controller.ts`** — `@injectable()`; arrow-function methods; validate → call service → `sendSuccess`. No business logic.
7. **`routes.ts`** — every route is `router.<verb>(path, userGuard | serviceGuard, authorize(policy), [idempotency], ctrl.method)`. A route without `authorize(...)` is a review blocker.
8. **`policies.ts`** — the RBAC + ownership policy for each route (see "Authorization — RBAC and ownership").
9. **`enums.ts`** — string enums whose values match DB `CHECK` constraints exactly.
10. **`errors.ts`** — exported `AppError` instances: `export const AccountSuspended = new AppError("AccountSuspended", 403, "Account is suspended");`
11. **`types.ts`** — every non-entity interface/type alias for the module. **Inline `interface`/`type` declarations in controller, service, repository, guard, client, or middleware files are forbidden.**

---

## Database rules

- **Migrations are raw SQL** in Knex `up`/`down` (`knex.raw`); schema builder forbidden. Use the `write-migration` skill. Never edit a migration that has run anywhere — write a new one. Every `up` has a real `down`.
- **`TIMESTAMPTZ` everywhere**, stored in UTC (`SET TIME ZONE 'UTC'` on every pool connection). `TIMESTAMP` without time zone is forbidden.
- **Soft delete only:** `deleted_at TIMESTAMPTZ NULL`. No `DELETE` statement against business tables in application code; hard delete is never exposed. Uniqueness is enforced among live rows with partial unique indexes (`WHERE deleted_at IS NULL`).
- **Email** is `CITEXT` with `uq_users_email` partial unique index on live rows.
- **Secrets are never stored in plaintext:** `password_hash` (argon2id), `refresh_tokens.token_hash` (sha256 of a 256-bit random token), `password_resets.token_hash`, `registration_challenges.code_hash` (HMAC-SHA256 with `OTP_PEPPER`), `service_clients.client_secret_hash` (argon2id). One-time secrets are generated by the worker at send time; `outbox_jobs` rows hold ids only — never PII or secrets.
- **Enum-like columns:** `VARCHAR(n) NOT NULL CHECK (col IN (...))`, never native `ENUM`.
- **Every FK** is named and covered by an index whose leading column is the FK column.
- **Indexes exist only for a query in code**, each with a comment naming that query. Composite order: equality columns, then range/sort column.
- **No defaults on critical columns** (`role`, `status` are always set explicitly by the service).
- **Transactions:** the service owns them (`db.transaction()`, explicit commit/rollback); repositories accept `conn`; never nest.
- **Status history:** every change to `users.status` inserts a `user_status_changes` row (`user_id, from_status, to_status, actor_user_id NULL, actor_service NULL, reason, request_id, created_at`) **in the same transaction**.

Expected tables (created by modules as they are built, not before): `users`, `refresh_tokens`
(`user_id, family_id, token_hash, expires_at, revoked_at, revoked_reason, replaced_by_id, device_info`),
`password_resets`, `registration_challenges`, `outbox_jobs`, `service_clients`, `user_status_changes`
(definitions: `docs/architecture/data-model.md`).

---

## API conventions

**Base paths:** public `/api/*` on `PORT` (local `3000`); internal `/internal/*` on `INTERNAL_PORT` (local `3100`); `GET /api/health/live|ready`, `GET /internal/health/live|ready` (readiness fatal on Postgres only, ADR 0014; never routed by the edge); `GET /.well-known/jwks.json` (public listener). Production is a single public origin with edge path routing (hub ADR 0005). Care runs locally on `3001` / `3101`.

**One error envelope** — identical in both vcare services, produced only by `lib/error/errorHandler.ts`:
```json
{ "success": false, "error": { "code": "ValidationFailed", "message": "Request validation failed", "details": [{ "field": "email", "issue": "must be an email" }], "requestId": "7f1c…" } }
```
Success: `{ "success": true, "data": <payload>, "meta": { … } }` (`meta` only when present, e.g. pagination).
Unknown errors become `InternalError` (500) with no stack or internals in the body.

**Request id:** `lib/request-id` accepts an incoming `X-Request-Id` (UUID format only, else regenerate), sets `req.requestId`, echoes it on every response, and it appears on every log line.

**Pagination:** every list is **cursor-based keyset** — `?cursor=<opaque>&limit=<1..100, default 20>`; the cursor encodes `(sortValue, id)` so ties are stable. Response `meta: { nextCursor, hasMore, count }`. Fetch `limit + 1`. Lists are filterable via whitelisted query params only.

**Idempotency:** `Idempotency-Key` (UUID) is **required** on `POST /api/auth/register/complete` and optional on other POSTs. When Redis is unavailable the middleware is skipped and database constraints stop duplicates (ADR 0008). Stored in Redis for 24 h keyed by `(route, principal-or-ip, key)` with a hash of the request body; same key + different body → `422 IdempotencyConflict`; same key + same body → replay the original status and body; same key while the first request is still in flight → immediate `409 Conflict` with `Retry-After: 1`.

**Status codes:** 200 read/update · 201 create · 204 no body · 400 `ValidationFailed` · 401 `Unauthorized`/`TokenExpired`/`InvalidCredentials` · 403 `Forbidden`/account-state errors · 404 `NotFound` · 409 `Conflict` · 422 `IdempotencyConflict` · 429 `RateLimited` · 500 `InternalError` · 503 dependency down (health only).

**Error codes owned by Identity** (stable):

| Code | HTTP | When |
|---|---|---|
| `ValidationFailed` | 400 | DTO validation failed |
| `Unauthorized` | 401 | missing/invalid bearer token |
| `TokenExpired` | 401 | access token expired |
| `InvalidCredentials` | 401 | wrong email/password (never reveals which) |
| `RefreshTokenInvalid` | 401 | refresh token unknown, expired, or revoked |
| `RefreshTokenReused` | 401 | a rotated refresh token was presented again → family revoked |
| `EmailNotVerified` | 403 | action requires a verified email |
| `AccountPending` | 403 | doctor account awaiting verification tried a doctor-only action |
| `AccountSuspended` | 403 | suspended account |
| `AccountRejected` | 403 | reserved — not returned by Identity (rejected accounts can sign in, ADR 0004) |
| `Forbidden` | 403 | role or ownership check failed |
| `ServiceTokenRequired` | 401 | `/internal/*` called without a valid service token (incl. with a user token) |
| `InsufficientScope` | 403 | service token lacks the required scope |
| `NotFound` | 404 | resource absent (or not visible to the caller) |
| `Conflict` | 409 | e.g. email already registered, or an `Idempotency-Key` whose first request is still in flight (with `Retry-After: 1`) |
| `InvalidStatusTransition` | 409 | status change not allowed by "Domain rules" |
| `IdempotencyConflict` | 422 | same key, different body |
| `RateLimited` | 429 | limiter tripped |
| `InternalError` | 500 | unhandled |

---

## Authentication and service-to-service auth

**Signing keys.** Ed25519 keypairs; the private key comes from a secret (`JWT_PRIVATE_KEYS` — JSON list with `kid`), never from the repo. `GET /.well-known/jwks.json` publishes current + previous public keys (`Cache-Control: max-age=300`). Rotation: add new key → publish for ≥ 1 access-TTL → start signing with it → retire the old key after refresh-TTL.

**User access token** (15 min): `iss=vcare-identity`, `aud=["vcare-identity","vcare-care"]`, `sub=<user id as string>`, `typ=user`, `role`, `status`, `ev` (email verified boolean), `iat`, `exp`, `jti`. Sent as `Authorization: Bearer <token>`. Never in a cookie, never in a URL.

**Refresh token** (30 days, opaque 256-bit random, only its sha256 stored): set as cookie
`vcare_rt; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=<ttl>` (path covers `/refresh` and `/logout`).
- **Rotate on every use:** `/api/auth/refresh` revokes the presented token (`revoked_reason='rotated'`, `replaced_by_id`) and issues a new one in the same family, in one transaction.
- **Reuse detection:** presenting an already-rotated token revokes the **entire family** (`revoked_reason='reuse_detected'`) and returns `401 RefreshTokenReused`.
- **Grace window (ADR 0005):** if the presented token was rotated less than `REFRESH_REUSE_GRACE_SECONDS` (10 s) ago and its successor is still live, return `401 RefreshTokenInvalid` **without** revoking the family and **without** a clearing `Set-Cookie`.
- Refresh re-reads the user: `suspended` → revoke family, `403 AccountSuspended`. `rejected` (and `pending`) may refresh.
- Logout revokes the presented token's family and clears the cookie. `DELETE /api/users/:id/sessions` (admin) revokes all of a user's families.
- **Password change or reset revokes all other refresh tokens.**

**Service-to-service auth (client credentials).**
- `POST /internal/auth/token` with `grant_type=client_credentials`, `client_id`, `client_secret`, `scope`, `audience`. Secret verified against `service_clients.client_secret_hash`; requested scopes ⊆ `allowed_scopes`.
- Returns a JWT (TTL **300 s**): `iss=vcare-identity`, `sub=<client_id>`, `typ=service`, `aud=<requested audience>`, `scope="users:read users:status:write"`, `jti`. No refresh token.
- Scopes: `users:read` (batch lookup), `users:status:write` (status changes), `users:contact:read` (notification contact lookup, **care-service only**, ADR 0024 — enforced by a `CHECK` on `service_clients` and the provisioning scripts), `doctors:read` (Care's internal summary — Identity only issues it).
- `service-guard` on every `/internal/*` route (except `/internal/auth/token` and `/internal/health`): valid signature, `typ=service`, `aud` includes `vcare-identity`, required scope present. **A user token on an internal route → `401 ServiceTokenRequired`, even an admin's.**
- **Never trust `X-User-Id`, `X-Role`, `X-Forwarded-User`, or any caller-supplied identity header.** The only principal is the verified token. The acting admin on an internal status change travels in the body (`actorUserId`) and is recorded as data, not trusted as authorization.
- Static long-lived API keys and shared databases are forbidden.

---

## Authorization — RBAC and ownership

**Deny by default.** `authorize(policy)` runs on every route; a route with no policy fails closed (500 at boot in dev, review blocker always). A policy declares **roles** and an **ownership predicate**; both must pass. Use the `rbac-ownership-guard` skill.
Authentication and authorization stay separate: `user-guard` / `service-guard` only verify the token and set
`req.auth`; `authorize(policy)` only decides access. Policies list roles **explicitly** — there is no "any
authenticated user" wildcard, so a new role gets no access until policies name it (ADR 0010).

```ts
// app/users/policies.ts
export const getUserPolicy: Policy = { roles: ["admin"], owner: "none" };
export const getMePolicy: Policy = { roles: ["patient", "doctor", "admin"], owner: "self" };
```

| Route | Roles | Ownership | Account-state requirement |
|---|---|---|---|
| `POST /auth/register/start`, `/auth/register/complete`, `/auth/login`, `/auth/forgot-password`, `/auth/reset-password` | public | — | rate-limited; login allowed for `pending`, `active`, `rejected` |
| `POST /auth/refresh`, `/auth/logout` | refresh cookie | token's own family | not suspended/rejected (refresh) |
| `POST /auth/change-password`, `GET /auth/me`, `PATCH /auth/me` | patient, doctor, admin | self | any non-suspended (`rejected` allowed) |
| `GET /users`, `GET /users/:id` | admin | none | active |
| `PATCH /users/:id/status` | admin | none; cannot target self, another admin, or a **doctor** (`403 Forbidden`, ADR 0012) — patients only | active |
| `GET /users/:id/sessions`, `DELETE /users/:id/sessions` | admin | none | active |
| `GET /internal/users?ids=` | service token | scope `users:read` | — |
| `PATCH /internal/users/:id/status` | service token | scope `users:status:write` | — |
| `GET /internal/users/contacts?ids=` | service token | scope `users:contact:read` (care-service only) | — |

`PATCH /auth/me` may change `fullName, phone, avatarUrl, timezone, locale` only — never `email`, `role`, `status`.
A non-owner receives `404 NotFound` where revealing existence would leak data (e.g. `/users/:id` is admin-only, so 403 is fine there).

---

## Security rules

- **Passwords:** argon2id `memoryCost=19456 KiB, timeCost=2, parallelism=1` (tune upward, never down). Legacy bcrypt hashes are verified then rehashed on successful login. Minimum length 10, max 128, checked against a small breached-password denylist. Never log, return, or compare passwords with `===`.
- **Login:** constant-shape response for unknown email vs wrong password (`InvalidCredentials`); a dummy argon2 verify runs when the email is unknown to equalize timing.
- **Rate limits (Redis sliding window):** login 5/min per IP+email and 20/min per IP · register/start 3/h per email and 5/h per IP · register/complete 10/h per IP · forgot 3/h per email · reset 10/h per IP · refresh 30/min per family · `/internal/auth/token` 60/min per client. Limiters run before validation and hashing.
- **Redis down (ADR 0008):** credential-route limiters fall back to an in-process per-task limiter at `max(1, floor(limit / RATE_LIMIT_FALLBACK_DIVISOR))` and alert; refresh fails open; Redis is Tier 2 and never fails readiness.
- **Hashing load:** argon2 runs behind a bounded semaphore (`HASH_CONCURRENCY`, `HASH_QUEUE_MAX`); a full queue returns `429 RateLimited`, never an unbounded wait.
- **One-time secrets:** registration code (6 digits, 10 min from send, max 5 attempts, HMAC-SHA256 with `OTP_PEPPER`, single-use `consumed_at`; ADR 0006) and password reset (30 min, 256-bit random, sha256, single-use `used_at`). Both are generated by the worker at send time and invalidate earlier open ones of the same kind. `register/start` always returns `202` (no account enumeration).
- **Forgot-password** always returns 204 regardless of whether the email exists.
- **Headers:** `helmet`; CORS allowlist from env (`CORS_ORIGINS`) in local development only — production is a single origin with CORS disabled (hub ADR 0005); `Cache-Control: no-store` on every `/api/auth/*` response.
- **Env:** every variable declared in `lib/config/env.ts` (zod) — **no defaults on secrets**; the process refuses to start on invalid env.
- **Internal listener** binds to the private interface only; ingress never routes `/internal`.

---

## Privacy and logging

- Structured JSON, one line per event: `level, message, timestamp (ISO UTC), requestId, service="identity-service", userId?, clientId?, route, status, durationMs`.
- **Never log:** passwords, password hashes, access/refresh/reset/verification tokens, client secrets, `Authorization` or `Cookie` headers, email addresses, phone numbers, full names, request bodies of `/auth/*`. The logger redacts these keys by name as defence in depth — but do not rely on it; don't pass them.
- Errors log the stack server-side only; the response carries the envelope.
- No emojis. Levels: `debug` (dev only), `info`, `warn`, `error`.
- Seed and demo data is fully synthetic (`@example.test` emails).

---

## Cross-service integration

Identity is the **provider** in all five platform integration cases (details: hub `architecture/landscape.md`; skill `cross-service-integration`).

| Case | Caller → endpoint | Identity's contract |
|---|---|---|
| 1 — Verification unlocks the account | Care → `PATCH /internal/users/:id/status` `{ status: "active" \| "rejected" \| "pending", reason, actorUserId }` (`pending` = Care re-opened a rejected application) | idempotent: setting the current status again returns 200 with no new history row; valid transitions only (else `409 InvalidStatusTransition`, which callers must treat as non-retryable); returns `{ id, status, updatedAt }` |
| 2 — Batch profile hydration | Care → `GET /internal/users?ids=1,2,3` | one query `WHERE id = ANY($1) AND deleted_at IS NULL`; ≤ 100 ids (else `400 ValidationFailed`); unknown ids are **omitted**, not errors; returns `[{ id, fullName, avatarUrl, role, status, timezone, locale }]` — **no email or phone** |
| 3 — Suspension revokes sessions | Care → `PATCH /internal/users/:id/status` `{ status: "suspended", reason, actorUserId }` | status update + revoke **all** refresh-token families + status-history row in **one transaction**; only then 200. Already `suspended` → 200 no-op (still ensures no live refresh tokens). Target not `active` → `409 InvalidStatusTransition` (Care only suspends approved doctors, so this signals drift and Care alerts instead of retrying) |
| 4 — Reinstatement restores the account (ADR 0023, hub ADR 0009) | Care → `PATCH /internal/users/:id/status` `{ status: "active", reason, actorUserId }` | `suspended → active` is accepted here (and only here for doctors); already `active` → 200 no-op with no new history row, so Care's retrier can call blindly; writes a `user_status_changes` row, revokes nothing and revives no refresh token (the user signs in again); any other pair → `409 InvalidStatusTransition` (non-retryable) |
| 5 — Notification contacts (ADR 0024, hub ADR 0010) | Care's worker → `GET /internal/users/contacts?ids=1,2,3` | one query `WHERE id = ANY($1) AND deleted_at IS NULL`; ≤ 100 ids (else `400 ValidationFailed`); unknown ids are **omitted**; returns `[{ id, email, fullName, locale, status }]` — **no phone**; `Cache-Control: no-store`; the caller holds it in memory for one batch, Identity logs counts only, never an address |

**Rules for Identity as provider**
- Internal endpoints are **fast and boring**: no outbound calls on these paths, p95 < 50 ms.
- Status changes are idempotent so the caller can retry blindly (Case 3 retries until success).
- `X-Request-Id` from the caller is adopted and logged, so one trace spans both services.
- Contract changes to `/internal/*` are breaking for Care: change `contracts/openapi.yaml` first, keep the old shape until Care has shipped against the new one, and record it in the hub.

**Batch lookup field names:** Identity returns `fullName`; consumers may rename it for display (Care exposes it as `displayName`). The provider field name is `fullName` in the contract.

**`doctors:read` scope:** Identity issues it, but no MVP service client holds it; it exists for admin tooling and the Phase-2 AI service to call Care's `/internal/doctors/:userId/summary` once such a client is provisioned (hub `TODO.md`).

**Doctor account status — Care is the only initiator (ADR 0012, hub ADR 0006):** `PATCH /api/users/:id/status` refuses doctor targets with `403 Forbidden`, so every doctor status change arrives through `PATCH /internal/users/:id/status` from Care and Care's state always moves with it. A suspended doctor is reinstated only through the same internal route (`suspended → active`, Case 4, ADR 0023); the public admin route still refuses doctor targets.

---

## Domain rules

1. **Registration (ADR 0006):** email-first. `register/start` always returns `202` and queues a code (unknown email) or an "account exists" notice (known email). `register/complete` with a valid code creates the account with `email_verified_at=now()`; `role ∈ {patient, doctor}` only; patients start `status=active`, doctors `status=pending`. Email delivery runs through the outbox and never fails a request.
2. **Email verification** is proven before the account exists; there is no verify-email or resend flow. The `ev` claim stays (always `true` for such accounts) because Care relies on it for "patients must have a verified email before booking".
3. **Status transitions** (anything else → `409 InvalidStatusTransition`):
   | From | To | Who |
   |---|---|---|
   | `pending` | `active`, `rejected` | Care (Case 1) |
   | `rejected` | `pending` | Care (Case 1 path, when an application is re-opened or resubmitted) |
   | `active` | `suspended` | Care (Case 3) for doctors; admin (Identity API) for patients |
   | `suspended` | `active` | admin (Identity API) for patients; Care (Case 4, internal route, ADR 0023) for doctors |

   Setting the status a user already has is a 200 no-op. Every other pair is `409 InvalidStatusTransition`.
4. **Entering `suspended` or `rejected` revokes all refresh tokens** in the same transaction. Access tokens already issued expire within 15 minutes; the residual window is accepted and documented (ADR 0002). Care additionally blocks suspended doctors locally at once.
5. `suspended` accounts cannot log in or refresh. `pending` and `rejected` doctors can log in (to complete onboarding or fix and resubmit in Care); their token carries that status (ADR 0004).
6. **Admins cannot change their own status**, another admin's status, or a **doctor's** status through the API (doctor status changes only via Care, ADR 0012).
7. **Password change** requires the current password and revokes all other refresh-token families. **Password reset** revokes all families.
8. **Email change** is out of scope for MVP (`PATCH /auth/me` rejects `email`).
9. **Soft delete** of an account sets `deleted_at`, revokes all tokens, and frees the email for re-registration; the row is never hard-deleted. PII is retained on soft delete in MVP (ADR 0011, revisit before GA).
10. All timestamps UTC; each user has an IANA `timezone` (validated) and `locale` (BCP-47).

---

## Testing policy

- **Unit tests** (`tests/unit/`): isolate one unit; mock collaborators (repositories, other services, Redis, clock, email port). Infra-failure scenarios (DB down → 503) are unit tests. Fast (< 100 ms each).
- **Integration tests** (`tests/integration/`): supertest against the **real** app wiring, **real** Postgres, **real** Redis. **Never mock services or repositories.** Mock only system-external dependencies (the email provider). Truncate tables per suite. No infra mocks in `tests/setup.ts`.
- **Contract conformance:** integration tests assert status codes, error `code`s, and response shapes from `contracts/openapi.yaml`. A mismatch is a failing test, never a doc edit.
- **Mandatory scenarios:** every rule in "Domain rules" has a named test; every route has RBAC tests (wrong role → denied, non-owner → denied, owner/allowed role → allowed); refresh rotation + reuse detection revokes the family; suspension revokes all sessions and a subsequent refresh fails; user token on `/internal/*` → 401; missing scope → 403; `/internal/users` omits unknown ids and caps at 100; pagination page 2 reachable on the default sort; idempotent replay and conflict; no secret appears in any response body; refresh within the grace window does not revoke the family while a later replay does; `register/start` responds identically for known and unknown emails; a registration code fails after 5 attempts and after expiry; the admin status route refuses a doctor target; login and refresh succeed for a `rejected` account; with Redis down, login still works under the fallback limiter and readiness stays 200; outbox rows never contain PII or secrets.
- Names: `should <do something> when <condition>`. Do not test the framework.

---

## Performance rules

1. No N+1 — batch with `= ANY($1)` / `whereIn`.
2. Every query is backed by an index; `EXPLAIN` the hot paths before merging.
3. Never `SELECT *`.
4. Budgets (p95): `/api/auth/refresh` < 50 ms · `/internal/users` (100 ids) < 50 ms · `/.well-known/jwks.json` < 10 ms (cached) · login < 250 ms including argon2 · other writes < 200 ms.
5. Email sending, cleanup of expired tokens, and anything slow run **outside** the request (queued/async job).
6. Cursor pagination everywhere; `limit` ≤ 100.

---

## Code style — what to avoid

- ❌ ORMs, decorators on entities, repository classes (use functions)
- ❌ Returning entities or rows from controllers (response DTOs only)
- ❌ Cross-module repository imports (go through the service)
- ❌ Business logic in controllers or middleware
- ❌ A route without `authorize(...)`
- ❌ Reading identity from headers other than a verified `Authorization` bearer token
- ❌ `try { … } catch (e) { console.log(e) }` — rethrow or convert to `AppError`
- ❌ `any` in signatures; inline `interface`/`type` outside `types.ts`
- ❌ Plaintext secrets at rest; logging any secret or PII
- ❌ Env vars not declared in `lib/config/env.ts`; defaults on secrets
- ❌ `SELECT *`; `TIMESTAMP` without time zone; hard `DELETE`
- ❌ Inline time math (`Date.now() + 15 * 60 * 1000`) — use `pkg/utils/time.ts` (`addTime`, `toMs`, `isPast`)
- ❌ Changing an endpoint's shape without changing `contracts/openapi.yaml` first

---

## Build order for a new module

0. **Contract** — add/adjust the operations in `contracts/openapi.yaml` (roles via `x-roles`, ownership via `x-ownership`, every error code).
1. Migration (table + constraints + indexes, each index commented).
2. `enums.ts`, `errors.ts`, `types.ts`.
3. Entity.
4. Request DTO(s).
5. Response DTO(s).
6. Repository functions.
7. Service (register in `container.ts`).
8. `policies.ts`.
9. Controller (register in `container.ts`).
10. `routes.ts` (guard → authorize → idempotency → handler).
11. Mount in `src/routes.ts` or `src/internal-routes.ts`.
12. Tests (unit + integration + RBAC + contract conformance).
13. Manual QA with CURL.
14. Docs (`docs/<module>/`, `docs/service-card.md`, `docs/INDEX.md`).

Implement one module end-to-end before starting the next (parallel modules only via `/develop-feature-e2e` worktrees).

---

## Out of scope

- Social login / OAuth providers, SSO, MFA (future ADR)
- Admin provisioning CLI, invitation links, shorter admin token lifetimes (ADR 0010)
- PII anonymization and self-service account deletion (ADR 0011)
- SMS/WhatsApp, phone verification
- Email change flow
- Payments, and everything in PRD §13
- Doctor credentials and verification documents (Care owns them)
- Message bus / events — MVP is HTTP-only; `user.status_changed` and `user.registered` events are future (no AsyncAPI contract yet)
- The Phase-2 AI service (it will be a new service client with its own scopes, not a change here)

---

## Workflow and documentation discipline

Feature work runs through slash commands, each backed by a focused subagent. **Every phase reads the relevant docs first and updates them as it works** — docs are part of the deliverable.

| Command | Does | Runs as |
|---|---|---|
| `/system-design <topic>` | interactive architecture dialogue → `docs/system-design.md`, `docs/architecture/*`, `docs/adr/*` for service scope; hub docs for platform scope (classified with the `docs-placement` skill) | inline |
| `/brainstorm <feature>` | interactive intent/scope → `docs/<module>/brainstorm.md` | inline |
| `/construct-spec <module>` | `docs/<module>/spec.md` (parallel recon when ≥ 2 large sources) | `flow-spec-author` |
| `/develop <module> [--fix-review]` | spec → `tasks.md` → code, task by task | `flow-developer` |
| `/write-tests <module>` | unit + integration + RBAC + contract tests | `flow-test-author` |
| `/manual-qa <module>` | CURL every endpoint → `manual-qa.md` + `scripts/curl-test-<module>.sh` | `flow-qa-runner` |
| `/review-code <module>` | review lifecycle; parallel dimension reviewers + adversarial verification for non-trivial modules | `flow-code-reviewer` |
| `/update-docs <module>` | reconcile docs + contract with as-built code | `flow-docs-updater` |
| `/develop-feature-e2e <feature>` | the whole loop; independent units in parallel worktrees | orchestrates all |

`/review-code` is deliberately not named `code-review` (that would shadow the bundled command).
Subagents cannot spawn subagents, so **all fan-out is orchestrated by the command**, never inside an agent.

**Task status (`docs/<module>/tasks.md`):** `- [ ]` todo → `- [~]` in progress → `- [x]` done, each task tagged with its "Build order for a new module" step. Never mark `[x]` while typecheck or tests fail.

**Code-review lifecycle:** `/review-code` writes `docs/<module>/reviews/review-<YYYYMMDD-HHMM>.md` (findings `- [ ] OPEN — …` with `file:line`, failure scenario, fix, test gap); `/develop --fix-review` flips them to `- [x] RESOLVED — …` or `- [ ] DISPUTED — …`; re-running `/review-code` verifies each fix and **deletes the file only when everything is verified and nothing new is found**. No review file = clean module.

**Manual QA:** CURL against a local server with `Authorization: Bearer`, the refresh cookie jar, `Idempotency-Key`, and `X-Request-Id`; compare to the contract's status and error codes, not to 200; redact tokens.

---

## Architect mode — /system-design

**Trigger:** the user says "let's system design" (any casing/phrasing of that intent) or runs `/system-design <topic>`.
Run the `/system-design` command **inline** — never delegate the dialogue or the writing to a subagent.

It works at architecture altitude, like `/brainstorm` one level up:
1. Read the hub first (`../vcare-hub/INDEX.md` → `architecture/overview.md`, then the platform docs the topic touches — `landscape.md`, `data-ownership.md`, `deployment.md`, `capacity.md` — the relevant PRD section, the other service's synced contract), then this repo's `docs/system-design.md`, `docs/architecture/*`, `docs/adr/*`, `contracts/openapi.yaml`.
2. Ask **one question at a time**; for each decision propose **2–3 options with trade-offs and a recommendation**; the user decides.
3. **Classify every output by scope** before writing (see "Doc placement — hub or service"; `docs-placement` skill).
4. Write service-scope results here: `docs/system-design.md` (router), `docs/architecture/<topic>.md` shard(s), `docs/adr/NNNN-<slug>.md` for each decision; flag required contract changes.
5. Write platform-scope results to the hub: `architecture/overview.md`, `deployment.md`, `capacity.md`, `landscape.md`, `data-ownership.md`, `glossary.md`, hub `adr/` for platform-wide decisions. Split topics (capacity, deployment, availability, observability) → the platform part and this service's roll-up row in the hub, the derivation here.

---

## Documentation structure

```
docs/
  INDEX.md             # router — READ FIRST
  service-card.md      # 30-second summary — synced to ../vcare-hub/catalog/identity-service.card.md
  system-design.md     # architecture ROUTER → architecture/*.md (one doc = one job)
  architecture/        # SERVICE SCOPE ONLY: design-baseline, capacity (Identity derivation), deployment (Identity runtime),
                       # overview, data-model, api, auth-tokens, service-auth, infrastructure, future
  runbook.md           # on-call (how-to lens)
  quickstart.md        # first local run (tutorial lens)
  adr/NNNN-*.md        # append-only decisions
  <module>/            # created by the workflow: brainstorm, spec, tasks, manual-qa, reviews/
contracts/
  openapi.yaml         # SOURCE OF TRUTH for the HTTP API (public + /internal)
```

**Doc rules (enforced by every workflow command):**
1. **Frontmatter is mandatory** on every doc under `docs/`: `title, owner, service, status, last_verified, tags, related` (+ `module` for module docs, `diataxis` where it applies). Set `last_verified` to today (absolute date) whenever you touch a doc.
2. **The contract is the source of truth.** `spec.md` and `architecture/api.md` mirror `contracts/openapi.yaml`; on disagreement the contract wins.
3. **`docs/INDEX.md` stays current:** every doc has a row with "read it when…" and its Diátaxis lens.
4. **Diátaxis is a label, not a folder tree** — no `tutorials/`, `how-to/`, `reference/`, `explanation/` directories.
5. **Service card ↔ hub:** update `docs/service-card.md` when responsibilities, owned data, dependencies, or endpoints change; the hub is populated by `../vcare-hub/scripts/sync-from-spoke.sh` — never hand-copy into the hub.
6. **Decisions → ADRs** (`docs/adr/NNNN-*.md`), append-only; supersede, never rewrite.
7. **No per-module folders ahead of time** — `/brainstorm` creates `docs/<module>/` when the module is started.
8. **Place every doc by scope** (hub ADR 0008): platform-scope content goes to the hub, service-scope content stays here, split topics use the hub roll-up; never `service: platform` in this repo. See "Doc placement — hub or service".
9. **Keep all three repos in sync in the same session.** Any change that affects identity, care, or the hub updates every affected doc, `CLAUDE.md`, and shared skill in all three. A Stop hook (`.claude/hooks/docs-sync-check.sh`, identical in both spokes) enforces it: hub freshness, retired terms from `.claude/hooks/retired-terms.txt`, and hub card/contract drift. When a decision retires a name, add it to `retired-terms.txt` in both spokes.

---

## Doc placement — hub or service

Every doc and every fact has **one home, decided by scope** — never by the repo you happen to be working in (hub ADR 0008). Step-by-step procedure, placement table, and checklist: the `docs-placement` skill.

**Scope test — "whose code makes this true, and who must agree on it?"**

| If the doc or fact… | Scope | Home |
|---|---|---|
| describes the platform as a whole or two or more services: system context and container views, edge routing, network zones, how every service is deployed, the release pipeline, the availability roll-up, shared traffic assumptions, cross-service load, integration cases and failure policies, data ownership, shared terms, platform-wide decisions | **platform** | the hub — `../vcare-hub/architecture/{overview,deployment,capacity,landscape,data-ownership}.md`, `glossary.md`, `adr/`, `product/prd.md` |
| is made true only by this service's code: module map, layering, request pipeline, data model, API prose, env vars, this service's capacity derivation, runtime components and scaling, bottlenecks, metrics and alerts, runbook, quickstart, service decisions, module docs | **service** | this repo — `docs/` |
| has both parts (capacity, deployment, availability, observability, data ownership) | **split** | hub: the platform part + one **roll-up** row per service with headline values and a link; here: the derivation, linking to the hub for its inputs |

**When to read the hub**
- Working on this service's internals (a module, migration, route, test) → read `CLAUDE.md` and `docs/` only.
- Touching edge routing, networking, deployment, scaling, availability, release, or observability → hub `architecture/deployment.md` first, then the local shard.
- Sizing anything or changing a load assumption → hub `architecture/capacity.md` first, then `docs/architecture/capacity.md`.
- Touching a cross-service call, borrowed data, or a shared term → hub `landscape.md`, `data-ownership.md`, `glossary.md`, the other service's synced contract.
- Orienting on the whole system → hub `INDEX.md` → `architecture/overview.md`.

**When to write where**
- **Author each number once.** Platform inputs are authored in the hub; values derived from them are authored here. A local doc may quote a hub value only with a link to it — it is never the place to change it.
- Frontmatter `service: platform` ⇔ the file lives in the hub. Never create a `service: platform` doc here, and never copy a hub doc here; link to it. The Stop hook blocks the first.
- Only `/system-design` hand-edits hub docs (never the synced `catalog/*.card.md` or `contracts/*`). Every other phase writes this repo's `docs/` and **lists** platform deltas for `/system-design`.
- Changing a headline the hub rolls up (task counts, DB class, storage, availability target) updates the hub row in the same session.
- `docs/service-card.md` names hub docs in plain text — the sync rewrites its relative links to point into this repo.

---

## Cross-service context (the hub)

This repo knows only itself. For Care's contract, who calls whom, data ownership, glossary terms, platform deployment or capacity, or the PRD → the hub at `../vcare-hub`, starting at `INDEX.md`.

Retrieval escalates **cheapest first**; stop as soon as you have the answer:
1. **Local** — grep this repo.
2. **Hub `INDEX.md`** — find where the answer lives.
3. **Hub content** — platform overview, deployment topology, capacity model, landscape (integration), data-ownership, catalog cards, synced contracts, ADRs, glossary, PRD. Every platform-scope answer ends here.
4. **Sibling repo on disk?** If you need detail the hub lacks, check for `../vcare-care-api`. If present, read its docs directly. **If unsure whether it is checked out, ASK the user** before reaching out.
5. **GitHub MCP peek** — only if not local; read the specific file. Still no clone.
6. **Clone** — only to actually change or run that service. Never clone just to read docs.
