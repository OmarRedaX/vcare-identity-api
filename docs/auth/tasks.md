---
title: auth — Tasks
owner: identity-team
service: identity-service
module: auth
status: built
diataxis: reference
last_verified: 2026-10-04
tags: [tasks, auth, registration, refresh-token, jwks, outbox]
related: [auth-brainstorm, auth-spec, users-tasks]
---

# auth — Tasks

Source: [spec.md](./spec.md) (status: ready, version 1.1.0). Each task is tagged with its step from
CLAUDE.md → "Build order for a new module"; shared-infrastructure tasks that the module builds on its way
(spec §5) carry a `lib-*` tag and are ordered before the module artefacts that need them. Statuses are kept
live while building.

## Legend
- [ ] todo · [~] in progress · [x] done

## Units
Epic A (public surface) runs as two units, **serially** in this order:

| Order | Unit | Owns | Contract operations | Depends on |
|---|---|---|---|---|
| 1 | `identity:auth` | migrations `users`, `refresh_tokens`, `password_resets`, `registration_challenges`, `outbox_jobs`; `src/app/auth/`; `src/lib/{auth,rbac,outbox,email}/`; `pkg/utils/crypto.ts`; worker jobs; JWKS route | none new (11 `auth`/`keys` operations already applied) | none (builds on `foundation`) |
| 2 | `identity:users` | migration `user_status_changes`; `src/app/users/` | none new (5 `users` operations already applied) | `identity:auth` — `users` table, `user-guard`, `authorize`, refresh-token revocation service |

**Parallel gate: not passed.** `users` has a dependency path to `auth`, and both touch shared files
(migration ordering, `src/routes.ts`, `src/bootstrap.ts`/DI tokens). No cross-service dependency: neither unit
needs a new or changed endpoint in care-service.

## Tasks

### A — prerequisites (step 0)
- [x] A1 (contract) verify C-1…C-14 of spec §14.2 are applied in `contracts/openapi.yaml` (11 auth/keys operations, `PasswordResetCode`, no `OneTimeToken`)
- [x] A2 (docs) ADR 0016 — auth runtime dependencies (**before** `npm install`)
- [x] A3 (docs) ADR 0017 — password reset by one-time code (D-3)
- [x] A4 (deps) install `jose`, `argon2`, `bcrypt` (+ dev `@types/bcrypt`); add `keys:generate` and `admin:unusable-hash` scripts

### B — migrations (step 1)
- [x] B1 (migration) `20260917000100_create_users` — CHECKs + `uq_users_email` partial unique index
- [x] B2 (migration) `20260917000200_create_refresh_tokens` — 5 CHECKs, 2 unique + 3 plain indexes, commented
- [x] B3 (migration) `20260917000300_create_password_resets` — code-hash shape (D-3), 5 CHECKs, 2 indexes
- [x] B4 (migration) `20260917000400_create_registration_challenges` — 5 CHECKs, partial open index + purge index
- [x] B5 (migration) `20260917000500_create_outbox_jobs` — 5 CHECKs, 3 partial indexes

### C — shared infrastructure and module primitives (step 2 + spec §5)
- [x] C1 (lib-pkg) `pkg/utils/crypto.ts` (randomToken, randomUuid, randomDigits, sha256Hex, hmacSha256Hex, timingSafeEqualHex); `pkg/utils/time.ts` + `isPast`, `subtractTime`
- [x] C2 (lib-time) `lib/time/clock.ts` — `Clock` port + `systemClock`
- [x] C3 (env) `lib/config/env.schema.ts` new variables + `lib/config/requirements.ts` (API/worker) + `.env.example` + `.env.test`
- [x] C4 (enums-errors-types) `lib/error/errors.ts` + `TokenExpired`, `AccountSuspended`; `AppError.retryAfterSeconds` + `errorHandler` `Retry-After`
- [x] C5 (privacy) `lib/logger/redact.ts` + `otp`, `otpPepper`, `registrationCode`, `resetCode`, `jwtPrivateKeys`, `apiKey`, `emailProviderApiKey`, `deviceInfo`
- [x] C6 (lib-http) `lib/http/cookies.ts` (read/set/clear `vcare_rt`) + `sendAccepted`
- [x] C7 (lib-rate-limit) extract `consumeRateLimit(options, subject, deps?)`; `rateLimit()` becomes a wrapper
- [x] C8 (lib-knex) `lib/knex/advisory-lock.ts` — `withAdvisoryXactLock`
- [x] C9 (lib-validation) `lib/validation/decorators.ts` — `IsIanaTimeZone`, `IsBcp47Locale`, `IsNotBlank`, `MinProperties`
- [x] C10 (lib-password) `semaphore.ts`, `password-hasher.ts`, `denylist.ts`, `is-acceptable-password.ts`, `types.ts`
- [x] C11 (lib-auth) `constants.ts`, `keys.ts`, `jwt.ts`, `jwks.ts`, `user-guard.ts`, `types.ts`
- [x] C12 (policies) `lib/rbac/types.ts`, `authorize.ts`, `assert-routes-authorized.ts` (deny by default, boot check)
- [x] C13 (lib-outbox) `types.ts`, `outbox.repo.ts`, `backoff.ts`, `outbox-processor.ts`
- [x] C14 (lib-email) `types.ts`, `resend-adapter.ts`, `file-capture-adapter.ts`, `memory-capture-adapter.ts`
- [x] C15 (enums-errors-types) `app/auth/enums.ts`, `errors.ts`, `types.ts`

### D — entities (step 3)
- [x] D1 (entity) `User`, `RefreshToken`, `PasswordReset`, `RegistrationChallenge`

### E — DTOs (steps 4–5)
- [x] E1 (request-dto) `dto/auth.request.dto.ts` — RegisterStart, RegisterComplete, Login, ForgotPassword, ResetPassword, ChangePassword, UpdateMe
- [x] E2 (response-dto) `dto/auth.response.dto.ts` — `UserResponseDto`, `AccessTokenResponseDto`, `LoginResponseDto`

### F — repositories (step 6)
- [x] F1 (repository) `repository/user.repo.ts`
- [x] F2 (repository) `repository/refresh-token.repo.ts`
- [x] F3 (repository) `repository/password-reset.repo.ts`
- [x] F4 (repository) `repository/registration-challenge.repo.ts`

### G — services (step 7)
- [x] G1 (service) `RegistrationService` (start, complete)
- [x] G2 (service) `SessionService` (login, refresh, logout, revokeAllForUser, revokeAllExceptFamily)
- [x] G3 (service) `PasswordService` (forgot, reset, change)
- [x] G4 (service) `AccountService` (getMe, updateMe, findLiveById)
- [x] G5 (jobs) `jobs/email-templates.ts` — pure subject + text per job type
- [x] G6 (service) `AuthMailService` — worker job handlers
- [x] G7 (service) `PurgeService` — five retention purges under an advisory lock

### H — policies (step 8)
- [x] H1 (policies) `app/auth/policies.ts` — `publicPolicy`, `refreshFamilyPolicy`, `selfPolicy`

### I — controllers (step 9)
- [x] I1 (controller) `controller/auth.controller.ts` — the 10 `/api/auth` operations
- [x] I2 (controller) `controller/jwks.controller.ts` — `GET /.well-known/jwks.json`

### J — wiring (steps 10–11)
- [x] J1 (routes) `app/auth/routes.ts` — `buildAuthRouter` + `buildWellKnownRouter` (limiter → guard → authorize → limiter → idempotency → handler)
- [x] J2 (mount) `src/routes.ts` (`/auth`), `src/app.ts` (`/.well-known` + `assertRoutesAuthorized`), `src/internal-app.ts` (boot check)
- [x] J3 (di) `lib/di/tokens.ts`, `src/bootstrap.ts`, `src/types.ts` (`clock`, `signingKeys`, `emailPort`), `lib/types/types.ts` typed `UserAuth`
- [x] J4 (worker) `src/worker.ts` outbox + purge loops, `src/server.ts` `requireApiConfig` and eager key load
- [x] J5 (scripts) `scripts/generate-signing-key.ts`, `scripts/unusable-password-hash.ts`, `scripts/build-password-denylist.ts`

### K — verification and docs (steps 12–14)
- [x] K1 (verify) `npm run typecheck` and `npm run lint` clean
- [x] K2 (tests) ← `/write-tests auth` owns `tests/` (spec §11); green 2026-10-04: 472 unit, 162 integration (2 win32-skipped signal tests)
- [ ] K3 (manual-qa) ← `/manual-qa auth` (spec §12.3) — run 2026-10-04: 253 pass / 3 fail, 3 open defects (D-1 `+01:00` accepted as timezone, D-2 malformed JSON 400 and D-3 OPTIONS lack `no-store`); see [manual-qa.md](./manual-qa.md)
- [x] K4 (docs) `docs/service-card.md`, `docs/INDEX.md` rows, ADR index rows; remaining doc fixes (spec §12.2) → `/update-docs auth`

**Counts:** 50 tasks - 48 done, 0 in progress, 2 todo.

## As-built notes (2026-09-18, developer)
Verification run: `npm run typecheck` clean, `npm run lint` clean, `npm test` 23 suites / 164 tests passed
(foundation suites only — `tests/` belongs to `/write-tests auth`). A throwaway boot smoke check confirmed
`createApp` + `createInternalApp` build with the route check, that the check rejects an unguarded route
(including inside a nested router) and skips probe-exempt routers, and that `GET /.well-known/jwks.json`
returns `200` with `Cache-Control: public, max-age=300`, one `kid`, and no private field; `GET /api/auth/me`
without a token returns `401 Unauthorized` with `no-store`; `POST /api/auth/logout` without a cookie returns
`204` with the clearing cookie.

Deviations from `spec.md`, with reasons:
1. **`OutboxDeliveryError` lives in `src/lib/outbox/delivery-error.ts`**, not in `types.ts` (§5.4 listed it
   there): it is a class (a value), and `types.ts` is for types.
2. **`MinProperties` is enforced by `validateBody`, not by class-validator** (§3.5). With
   `useDefineForClassFields` every declared field is an own `undefined` property on the instance, so a
   class-level validator would always count 5; the rule is recorded on the class by the decorator and the raw
   body's key count is checked before transformation. Behaviour is exactly as specified
   (`400`, `{ field: "body", issue: "must contain at least one property" }`).
3. **`loadSigningKeys` is synchronous** (§5.1 implied `await importJWK`): it uses
   `node:crypto` + `KeyObject.toCryptoKey()` so the DI container can resolve the key set lazily on first use,
   which is what §5.8 requires (the worker and migration CLI never parse keys).
4. **`lib/config/requirements.ts` also exports the narrow accessors** `requireSigningConfig`,
   `requireOtpPepper`, `requireAppBaseUrl`, `requireEmailConfig` besides `requireApiConfig`/
   `requireWorkerConfig`, so services read a `string` rather than `string | undefined` without assertions.
5. **`SessionService.familyOfOwnToken`** was added (not named in §3.8) to resolve the change-password
   keep-family from the cookie only when the token belongs to the caller (BR-21).
6. **The password denylist holds the 5 000 most-used entries** of 10..128 characters (84 KB), generated from
   SecLists commit `6b0c02d4c3ccfc0f53a9bebfad46eb58a9101404`; §5.2 expected "low thousands, < 100 KB".
7. **Jest now runs through `node --experimental-vm-modules`** (`npm test`, `npm run test:integration`):
   `jose` v6 is ESM-only and `jest-runtime` only uses `require(esm)` when `vm.SourceTextModule` exists.
8. **Two foundation test assertions were updated** in `tests/unit/worker.test.ts` for the renamed worker
   loops (`outbox`, `purge`) — the spec renames them; no new tests were written.
9. `assertRoutesAuthorized` reports `route_without_policy: <METHOD> <route path>`; the mount prefix of a
   nested router is not part of the message (Express layers do not expose it).

Open, not done here:
- **Migrations have not been applied to a database**: Docker is not running in this environment, so
  `npm run migrate`, the `down()` rollback proof, and the `EXPLAIN` runs of §10 are outstanding. The SQL is
  raw and reviewed by eye; `/manual-qa auth` (or the first integration run) must apply and roll them back.
- `K2` tests → `/write-tests auth`; `K3` manual QA → `/manual-qa auth`.
- Doc fixes in spec §12.2 (data-model, infrastructure, auth-tokens, api, overview, quickstart, runbook,
  design-baseline, system-design) → `/update-docs auth`; this build touched only `INDEX.md`,
  `service-card.md` and the two new ADRs.
- `CLAUDE.md` human edits (spec §12.2, five items) remain for the user.

