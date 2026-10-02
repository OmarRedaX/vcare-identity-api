---
title: auth — Brainstorm
owner: identity-team
service: identity-service
module: auth
status: draft
diataxis: explanation
last_verified: 2026-09-17
tags: [brainstorm, auth, registration, login, refresh-token, jwks, password, outbox, email, worker]
related: [system-design, design-baseline, auth-tokens, data-model, infrastructure, api, users-brainstorm, adr-0002-asymmetric-jwt-rotating-refresh, adr-0003-argon2id-password-hashing, adr-0004-rejected-doctors-can-sign-in, adr-0005-refresh-reuse-grace-window, adr-0006-email-first-registration-otp, adr-0007-transactional-outbox-worker, adr-0008-redis-tier-2-fallback-limiter, adr-0010-manual-admin-provisioning-role-policies]
---

# auth — Brainstorm

Epic A ("public surface") = **`auth`** (this brief) then **[`users`](../users/brainstorm.md)**. Built serially:
`users` needs the `users` table, `user-guard`, `authorize`, and the refresh-token revocation that `auth` creates.

## Problem & purpose
Nobody can have an account or a session yet. `auth` delivers everything a person needs to **become a user and
stay signed in safely**: email-first registration, login, rotating refresh sessions, logout, password
change/forgot/reset, and their own profile. It also builds the **token and authorization infrastructure every
later module depends on** (EdDSA signing + JWKS, `user-guard`, deny-by-default `authorize`), and the
**outbox worker** that sends email and purges expired secrets. The design is settled (design baseline D1–D17,
ADRs 0002–0008, 0010, 0011) and the contract operations are already applied to `contracts/openapi.yaml`; this
module implements them.

## Actors
- **Visitor** (unauthenticated) — registers, logs in, requests a password reset.
- **Patient, doctor, admin** (user token) — refresh, logout, change password, read/edit own profile. `pending` and
  `rejected` accounts are allowed (ADR 0004); `suspended` is not.
- **identity-worker** — delivers outbox emails, generates one-time secrets at send time, runs purges.
- **care-service and other verifiers** — consume `/.well-known/jwks.json` to verify access tokens locally.
- **Ops** — create admin rows manually; admin sets the password via forgot/reset (ADR 0010).

## In scope (this iteration)
- **Endpoints** — all 11 `auth`/`keys` operations in the contract (see Primary flows).
- **Token infrastructure** (`src/lib/auth/`): `jwt.ts` (sign/verify with `jose`, EdDSA, `kid`), `jwks.ts` (key
  set from `JWT_PRIVATE_KEYS`/`JWT_ACTIVE_KID`, built once at boot), `user-guard.ts` (sets `req.auth`, maps
  expired → `TokenExpired`, else `Unauthorized`). `service-guard.ts` is **not** built here (Epic B).
- **RBAC** (`src/lib/rbac/`): `authorize(policy)` with explicit roles + ownership (`self`/`none`), deny by
  default, fail-closed boot check for routes without a policy (`rbac-ownership-guard` skill).
- **Password hashing** (`lib/` or `pkg/`): argon2id with the ADR 0003 parameters; bcrypt verify-then-rehash for
  legacy hashes; bounded semaphore `HASH_CONCURRENCY` / `HASH_QUEUE_MAX` → `429 RateLimited`; dummy verify for
  unknown emails; small breached-password denylist; length 10..128.
- **Crypto utils** (`pkg/utils/crypto.ts`): 256-bit random tokens, sha256 hex, HMAC-SHA256, 6-digit CSPRNG code,
  constant-time compare.
- **Outbox** (`lib/outbox/`): enqueue inside the caller's transaction; claim with `FOR UPDATE SKIP LOCKED` and a
  lease; exponential backoff; `dead` after `OUTBOX_MAX_ATTEMPTS`; `last_error` holds an error class only.
- **Email** (`lib/email/`): a port plus two adapters —
  - **Resend** HTTP adapter over Node `fetch` (no new dependency), 5 s timeout, `EMAIL_PROVIDER_*` env.
  - **Capture** adapter for local development and tests, selected by env (e.g. `EMAIL_PROVIDER=capture`);
    refused in production by env validation.
  - Job types: `send_registration_code`, `send_account_exists_notice`, `send_password_reset`. Plain templates,
    synthetic data only.
- **Worker jobs** (`src/worker.ts`): email delivery + **scheduled purges** under `pg_try_advisory_lock`, in
  batches, with the retention windows in [data-model.md](../architecture/data-model.md) → Retention for
  `refresh_tokens`, `password_resets`, `registration_challenges`, `outbox_jobs`.
- **Rate limits** wired per route using the existing middleware and in-process fallback (ADR 0008).
- **Migrations**: `users`, `refresh_tokens`, `password_resets`, `registration_challenges`, `outbox_jobs`.
- **Env**: the planned rows in [infrastructure.md](../architecture/infrastructure.md) (JWT, TTLs, `OTP_PEPPER`,
  `REFRESH_REUSE_GRACE_SECONDS`, `HASH_*`, `WORKER_BATCH_SIZE`, `OUTBOX_MAX_ATTEMPTS`, `APP_BASE_URL`,
  `EMAIL_PROVIDER_*`) plus the provider selector.
- **Runbook / quickstart**: local key generation, create-an-admin procedure verified end-to-end, auth walkthrough.

## Out of scope
- Admin user management, status changes, session list/revoke → `users` (Epic A, next).
- `service-guard`, `/internal/auth/token`, `/internal/users*` → Epic B.
- `user_status_changes` table → `users` (the first writer of status changes).
- Account soft delete — domain rule 9 exists but **no endpoint** in the contract; not built.
- Email change, MFA, social login, SMS, admin provisioning CLI, self-service session list (CLAUDE.md → Out of scope, future.md).
- Events (`user.registered`) — MVP is HTTP-only; the outbox is only the future carrier.

## Key entities & relationships
- `users` 1—* `refresh_tokens` (family = chain of rotations from one login; `replaced_by_id` self-reference).
- `users` 1—* `password_resets` (hash + expiry written by the worker at send time).
- `registration_challenges` keyed by `email` (no FK — the account does not exist yet).
- `outbox_jobs.aggregate_id` → challenge id, user id, or reset id depending on `type` (logical, no FK; ids only).
Full columns, constraints, and index-per-query: [data-model.md](../architecture/data-model.md).

## Primary flows / endpoints (with roles + ownership)
| Operation | Roles | Ownership | Notes |
|---|---|---|---|
| `POST /api/auth/register/start` | public | — | always `202`; unknown email → challenge + `send_registration_code`; known → `send_account_exists_notice`; invalidates open challenges; 3/h email, 5/h IP |
| `POST /api/auth/register/complete` | public | — | `Idempotency-Key` **required**; valid code → `users` insert (`email_verified_at=now()`, patient `active` / doctor `pending`) + `consumed_at` in one tx → `201 User`; bad/expired/exhausted code → `400 ValidationFailed field=code`; race → `409 Conflict`; 10/h IP |
| `POST /api/auth/login` | public | — | `pending`/`active`/`rejected` allowed, `suspended` → `403`; uniform `InvalidCredentials` + dummy verify; new family; access token + `vcare_rt` cookie; bcrypt rehash; 5/min IP+email, 20/min IP |
| `POST /api/auth/refresh` | refresh cookie | token's own family | rotate in one tx with `FOR UPDATE`; reuse → revoke family `401 RefreshTokenReused`; 10 s grace → `401 RefreshTokenInvalid` without revocation or clearing cookie; re-reads user, suspended → revoke + `403`; 30/min per family |
| `POST /api/auth/logout` | refresh cookie | token's own family | revoke family, clear cookie |
| `POST /api/auth/forgot-password` | public | — | always `204`; known email → `password_resets` row + `send_password_reset`, invalidates earlier open resets; 3/h email |
| `POST /api/auth/reset-password` | public | — | hash lookup, 30 min, single use → new hash + `used_at` + revoke **all** families in one tx; 10/h IP |
| `POST /api/auth/change-password` | patient, doctor, admin | self | current password required; revoke all families **except** the cookie's (all if no cookie) |
| `GET /api/auth/me` | patient, doctor, admin | self | any non-suspended |
| `PATCH /api/auth/me` | patient, doctor, admin | self | only `fullName, phone, avatarUrl, timezone, locale`; anything else `400` |
| `GET /.well-known/jwks.json` | public | — | from memory, `Cache-Control: public, max-age=300`, p95 < 10 ms |

`Cache-Control: no-store` on every `/api/auth/*` response.

## Business rules & state transitions
- Registration (domain rule 1, ADR 0006): code 6 digits, 10 min from send, 5 attempts (5th failure invalidates),
  HMAC with `OTP_PEPPER`, single use; `role ∈ {patient, doctor}`; initial status is not a status change (no history row).
- Refresh-token lifecycle: live → `rotated` (with `replaced_by_id`) | `reuse_detected` | `logout` |
  `password_changed` | `password_reset` | `status_changed` (refresh by a suspended user) — see
  [auth-tokens.md](../architecture/auth-tokens.md) → Revocation paths. Sliding 30-day expiry.
- Password reset token: 30 min from send, single use (`used_at`), superseded (`invalidated_at`).
- Login/refresh by status: `pending`, `active`, `rejected` allowed; `suspended` refused (domain rule 5).
- Outbox job: `pending → processing → done | pending (retry) | dead`; expired lease re-claimed.

## Cross-service touchpoints (case, direction, failure policy)
- **JWKS (Care → Identity, pull):** Care caches the key set and verifies locally; refetches on unknown `kid` at most
  once per minute. Identity outage does not break verification of already-cached keys. No new integration case.
- **Access token claims** (`role`, `status`, `ev`) are what Care authorizes on — their shape is the contract.
- No outbound calls from request paths. The only outbound call is worker → Resend (retry with backoff, never blocks
  a request).

## Privacy & audit
- Secrets at rest are hashes only (argon2id, sha256, HMAC). Plaintext codes/reset tokens exist only in worker memory
  and the email. `outbox_jobs` rows hold ids only — mandatory test.
- Never log passwords, tokens, cookies, emails, phones, names, or `/auth/*` request bodies. Rate-limit keys use
  `sha256(lower(email))`.
- The capture adapter holds plaintext codes by design (it replaces the inbox) — dev/test only, refused in production.
- Security events logged without PII: `login_failed`, `refresh_token_reuse_detected`, `refresh_token_grace_reuse`.
- Seed/demo data synthetic (`@example.test`).

## Constraints & guideline notes
- **New runtime dependencies:** `jose`, `argon2`, `bcrypt` are not in `package.json`. ADRs 0002 and 0003 choose them,
  but CLAUDE.md → Tech stack requires an ADR before adding a dependency, and ADR 0015 set the precedent of a
  dependency ADR per module. Expect **ADR 0016 — auth runtime dependencies** unless the spec shows 0002/0003 suffice.
- Budgets: refresh p95 < 50 ms; login p95 < 250 ms including argon2; JWKS < 10 ms; other writes < 200 ms.
- Mandatory tests from CLAUDE.md → Testing policy that land here: rotation + reuse, grace window vs later replay,
  `register/start` identical for known/unknown email, code fails after 5 attempts and after expiry, login and refresh
  succeed for `rejected`, Redis-down login under the fallback limiter with readiness 200, idempotent replay and
  conflict on `register/complete`, no secret in any response body, outbox rows free of PII and secrets, RBAC per route.
- Inline time math forbidden — `pkg/utils/time.ts`.

## Contract changes expected
None planned: all `auth` and `keys` operations were applied on 2026-09-16 (design baseline §4). The spec author
verifies the contract against this brief and flags any mismatch. Stale doc to fix during `/update-docs`: the
`docs/INDEX.md` status note still says the auth/users contract changes are pending.

## Open questions
1. **Dependency ADR:** new ADR 0016 for `jose` + `argon2` + `bcrypt`, or treat ADRs 0002/0003 as sufficient?
   (Recommendation: a short ADR 0016, matching the ADR 0015 precedent.)
2. **Capture adapter access:** the worker is a separate process, so manual QA cannot read an in-memory store over
   CURL. Options for the spec: write to a gitignored local file, or expose a dev-only endpoint on the internal
   listener disabled outside development. Must never be reachable in production.
3. **Suspended user holding a live access token** on `GET/PATCH /auth/me` and `change-password`: the contract lists
   `AccountSuspended`, but `user-guard` trusts the token's `status` snapshot. Should self routes re-read the user row
   (one PK read) to enforce it within the 15-min residual window? (Recommendation: yes for these write/self routes.)
4. **bcrypt legacy path:** no legacy hashes exist in production (new system); ADR 0003 keeps it for fixtures.
   Keep as decided unless the spec finds no consumer.
5. **Breached-password denylist:** source and size (e.g. a bundled top-10k list file) — spec decides.
6. **Resend account / sender domain** for non-local environments — ops prerequisite, tracked outside the code.

## Success criteria
- All 11 operations conform to `contracts/openapi.yaml` (status codes, error codes, shapes) in integration tests
  against real Postgres and Redis, with only the email provider mocked.
- A patient can register → log in → refresh repeatedly → change password → log out; a doctor registers as `pending`;
  a `rejected` account can log in and refresh; a `suspended` one cannot.
- Replaying a rotated refresh token outside the grace window revokes the family; inside it does not.
- The worker delivers codes and reset links via the capture adapter locally and purges expired rows without
  touching live ones.
- Typecheck, lint, unit and integration tests green; manual QA passes; review file cleared; docs reconciled.
