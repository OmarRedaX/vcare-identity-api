---
title: internal-users — Spec
owner: identity-team
service: identity-service
module: internal-users
status: ready
version: 1.0.1
diataxis: reference
last_verified: 2026-10-08
tags: [spec, internal-users, internal-listener, service-token, account-status, batch-lookup, contacts, revocation]
related: [service-auth-brainstorm, service-auth-spec, users-spec, auth-spec, service-auth, api, data-model, auth-tokens, adr-0002-asymmetric-jwt-rotating-refresh, adr-0004-rejected-doctors-can-sign-in, adr-0012-doctor-status-only-via-care, adr-0019-refresh-versus-suspension-lock-order, adr-0020-refresh-rotation-versus-revocation-lock-order, adr-0021-reason-field-not-redacted-in-logs, adr-0023-internal-status-accepts-suspended-to-active, adr-0024-notification-contacts-lookup-and-scope, adr-0025-internal-status-route-doctor-targets-only]
contracts: [contracts/openapi.yaml]
---

# internal-users — Spec

Source of truth for the HTTP shape is [`contracts/openapi.yaml`](../../contracts/openapi.yaml) (operations
`batchGetUsers`, `getUserContacts`, `internalUpdateUserStatus`). On any disagreement the contract wins and this spec is
stale. Intent: [service-auth/brainstorm.md](../service-auth/brainstorm.md) (it covers both modules; no separate
brainstorm exists), amended by [ADR 0023](../adr/0023-internal-status-accepts-suspended-to-active.md) (Case 4) and
[ADR 0024](../adr/0024-notification-contacts-lookup-and-scope.md) (Case 5), both accepted after the brief was written.
Machinery it builds on: [service-auth/spec.md](../service-auth/spec.md) section 3.4 (`serviceGuard`, `service` policy).

## 1. Overview

### 1.1 What the module owns
The three guarded `/internal/users*` routes of the internal listener, called only by `care-service`:

| Route | Case | Scope |
|---|---|---|
| `GET /internal/users?ids=` | 2, batch profile hydration | `users:read` |
| `GET /internal/users/contacts?ids=` | 5, notification contact lookup | `users:contact:read` (care-service only) |
| `PATCH /internal/users/{id}/status` | 1 (verification), 3 (suspension), 4 (reinstatement) | `users:status:write` |

The module owns no table. It adds a thin HTTP layer (`src/app/internal-users/`) and extends two existing services:
the **status-change transaction** in `UsersService` (the caller kind `service`, reserved by users spec D-1) and one
read method in `AccountService`. Business rules for status stay in `users`; there is no second copy.

### 1.2 Principles
- The only principal is the verified service token (`req.auth.kind = "service"`). `X-User-Id`, `X-Role` and any other
  identity header are never read. `actorUserId` in the body is **data**, never authority.
- Fast and boring: no outbound calls, no Redis, no outbox on these paths. Reads are one primary-key query; the write is
  one short transaction.
- Callers retry blindly: every status call is idempotent; `409 InvalidStatusTransition` is non-retryable by contract.
- Cross-module calls go through services. The module's controller calls `UsersService` (status) and `AccountService`
  (lookups); it never imports another module's repository.

### 1.3 Dependencies
- **service-auth (as-built):** `serviceGuard`, `Policy` kind `service`, `authorize`, `ServiceScope` including
  `users:contact:read`, `assertRoutesAuthorized` on the internal app.
- **users (as-built):** `UsersService.applyStatusChange` (extended, section 4), `status-transitions.ts`
  (`SERVICE_TRANSITIONS` added next to `ADMIN_TRANSITIONS`), `StatusCaller.Service`, `user-status-change.repo`.
- **auth (as-built):** `AccountService` (`lockLiveById`, `updateStatus`, `findContactsLive`), `SessionService.revokeAllForUser`,
  `RevokedReason.StatusChanged`, the user repo.
- **Other service:** none called. Care is the caller. No outbound calls.

### 1.4 Decisions
- **D-1 One status-change method, two transition tables.** `applyStatusChange` keeps its single transaction and lock
  order (ADR 0019/0020) and selects `ADMIN_TRANSITIONS` or `SERVICE_TRANSITIONS` by caller kind. The target rules
  (self / admin / doctor refusal) and the live-actor re-read apply to the `admin` caller only.
- **D-2 `SERVICE_TRANSITIONS`** (pure data): `pending -> [active, rejected]`, `rejected -> [pending]`,
  `active -> [suspended]`, `suspended -> [active]`. Every other pair is `409 InvalidStatusTransition`.
- **D-3 Doctor targets only (ADR 0025, amends ADR 0023).** After the existence check (absent or soft-deleted ->
  `404 NotFound`), a target whose role is not `doctor` is `403 Forbidden`, with no write. The scoped service token is
  still the authorization, and the target-role check limits what a leaked client can reach: a patient's or an admin's
  status is never changeable through `/internal`. `actorUserId` never authorizes anything.
- **D-4 Revocation rule.** Entering `suspended` or `rejected` revokes **all** refresh-token families
  (`revoked_reason = status_changed`) in the same transaction. Entering `active` or `pending` revokes nothing and never
  revives a revoked token (the user signs in again).
- **D-5 Already-`suspended` is a no-op that still revokes.** Same status again returns 200 with no history row and no
  `updated_at` move; for `suspended` only, the transaction still calls `revokeAllForUser` and commits, so a retried
  Case 3 guarantees the "no live refresh token" end state even if the first attempt died after the status write on a
  prior code path. Already-`rejected` does **not** revoke: rejected accounts may sign in (ADR 0004), so a live token
  after the status was set is legitimate. Other same-status calls write nothing.
- **D-6 Unknown `actorUserId`.** `user_status_changes.actor_user_id` has a foreign key to `users(id)` (soft-deleted
  rows keep their id, so a deleted actor is fine). An id that never existed would otherwise raise a foreign-key
  violation and a `500` that Care would retry forever. Decision: inside the status transaction the service checks
  existence with one primary-key read **including soft-deleted rows**; if absent, the history row stores
  `actor_user_id = NULL` (the `chk_user_status_changes_actor` check still holds because `actor_service` is always set),
  logs `status_change_actor_unknown` (ids only), and the call succeeds. No role or status check on the actor, ever.
  Ops alerts on `status_change_actor_unknown` (any occurrence) so the lost actor link is investigated; `actor_service`
  and `request_id` are always kept in the history row.
- **D-7 Auditing identity.** `actor_service` = the token `sub` (client id), `request_id` = `req.requestId` (UUID,
  adopted from the caller's `X-Request-Id`, so one trace spans both services).
- **D-8 No route limiter, no idempotency middleware.** Rate limiting token issuance does not bound requests made with
  an issued token, so the omission rests on other controls: the internal listener is reachable only on the private
  network, service clients are provisioned only by ops, and requests are monitored (structured logs with `clientId`,
  alerts on volume and on `status_change_actor_unknown`). PATCH to the same status is idempotent by nature, and
  `Idempotency-Key` is required only on `register/complete` (CLAUDE.md -> API conventions); the header is ignored here.
- **D-9 `ids` parsing.** Comma-separated canonical positive integers (`^[1-9][0-9]*$`, at most `Number.MAX_SAFE_INTEGER`),
  1..100 entries after parsing; duplicates are collapsed before the query (so `ids=1,1` is valid and returns one row);
  an empty string, an empty element (`1,,2`), a non-integer, a repeated `ids` key (array) or more than 100 distinct-or-not
  entries is `400 ValidationFailed`. The 100 cap counts entries as sent, before de-duplication.
- **D-10 Response caching.** `GET /internal/users`: no PII, no `no-store` (contract declares none). `GET /internal/users/contacts`
  and the PATCH response: `Cache-Control: no-store` (contract for contacts; the PATCH is added defensively and is
  harmless). Order of `data` is not guaranteed (do not add an `ORDER BY`).

### 1.5 File list (build order)
| Step | File | New / changed |
|---|---|---|
| 1 | `src/app/users/status-transitions.ts` | changed: add `SERVICE_TRANSITIONS` |
| 2 | `src/app/auth/types.ts`, `src/app/auth/repository/user.repo.ts` | changed: `UserSummaryRow`, `UserSummary`, `findSummariesByIds` (contacts side exists, ADR 0024 work in progress); `findExistsIncludingDeleted` (name per the repo rule: `IncludingDeleted`) |
| 3 | `src/app/auth/service/account.service.ts` | changed: `findSummariesLive(ids)`, `userExistsIncludingDeleted(id, conn)`; `findContactsLive` exists |
| 4 | `src/app/users/service/users.service.ts`, `src/app/users/types.ts`, `src/app/users/enums.ts` | changed: service caller branch of `applyStatusChange` (D-1..D-7); `StatusChangeCaller` already has the `service` variant |
| 5 | `src/app/internal-users/enums.ts`, `errors.ts` | not created: no new errors or enums |
| 6 | `src/app/internal-users/dto/internal-users.request.dto.ts` | new: `IdsQueryDto`, `InternalStatusChangeDto`; `UserIdParamDto` is imported from the `users` request DTOs (a DTO import is not a repository import) |
| 7 | `src/app/internal-users/dto/internal-users.response.dto.ts` | new: `UserSummaryResponseDto`, `UserContactResponseDto`, `InternalStatusChangeResponseDto` |
| 8 | `src/app/internal-users/policies.ts` | new: three `service` policies |
| 9 | `src/app/internal-users/controller/internal-users.controller.ts` | new; register `TOKENS.InternalUsersController` in `bootstrap.ts` / `tokens.ts` |
| 10 | `src/app/internal-users/routes.ts`, `src/internal-routes.ts` | new / changed: mount at `/users` on the internal router |
| 11 | `tests/unit/...`, `tests/integration/internal-users/...` | new |

No new service is needed: the controller depends on `UsersService` and `AccountService` (a thin `InternalUsersService`
would only forward calls and is not added).

## 2. Database schema

**No new table, column, index or migration.** Everything is covered by existing structures:

| Need | Existing structure | Query it serves |
|---|---|---|
| Batch lookup and contacts | `users` primary key | `SELECT <narrow columns> FROM users WHERE id = ANY($1) AND deleted_at IS NULL` |
| Row lock for the status write | `users` primary key | `SELECT <USER_COLUMNS> FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE` |
| Actor existence (D-6) | `users` primary key | `SELECT 1 FROM users WHERE id = $1` (deliberately no `deleted_at` filter, function name carries `IncludingDeleted`) |
| History insert | `user_status_changes` (`fk_user_status_changes_actor_user_id`, `chk_user_status_changes_actor`, `chk_user_status_changes_differs`, reason not blank) | `INSERT INTO user_status_changes ...` |
| Revoke all families | `refresh_tokens` user index used by `revokeAllForUser` | `UPDATE refresh_tokens SET revoked_at, revoked_reason WHERE user_id = $1 AND revoked_at IS NULL` |

Soft delete: `users` has `deleted_at`; every read above filters it except the actor existence check (D-6). The
`user_status_changes` table is append-only and has no soft delete. The migration `20261008000100` (scope vocabulary and
care-only `CHECK`, ADR 0024) belongs to the scope work already in the tree, not to this module's schema; this spec
depends on it for `users:contact:read` to be issuable.

Repository additions (functions, `conn: Knex = db`, explicit column lists, never `SELECT *`):
- `findSummariesByIds(ids, conn)`: columns `id, full_name, avatar_url, role, status, timezone, locale`. No email, phone,
  hash.
- `findContactsByIds(ids, conn)` exists: columns `id, email, full_name, locale, status`. No phone.
- `existsIncludingDeleted(id, conn)`: boolean.

## 3. API contract

Common to all three routes (internal listener only, `INTERNAL_PORT`): per-route order is
`serviceGuard -> authorize(policy) -> [noStore] -> handler`. `serviceGuard` is built with `{ keys, clock }` like the
service-auth probe. Guard failures are `401 ServiceTokenRequired` (including any user token, even an admin's);
`authorize` returns `403 InsufficientScope` when the scope is missing. Every response carries `X-Request-Id`. Responses
use the standard envelope. These routers are mounted only by `src/internal-routes.ts`; no public router imports them.

### 3.1 `GET /internal/users` (`batchGetUsers`)
- **Guard:** `service`. **Roles:** `[service]`. **Ownership:** `none`. **Scope:** `users:read`.
- **Policy:** `{ kind: "service", scope: "users:read", owner: "none" }`.
- **Query DTO `IdsQueryDto`:** `ids` required; parsed per D-9 into `number[]` (class-transformer `@Transform`, then
  `@IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsInt({ each: true }) @Min(1, { each: true })`). Unknown query
  parameters rejected (`forbidNonWhitelisted`).
- **Response 200:** `data: UserSummary[]`, each `{ id, fullName, avatarUrl, role, status, timezone, locale }`.
  `avatarUrl` is `string | null`. **Never** email, phone, hash, `emailVerifiedAt`. Unknown or soft-deleted ids are
  omitted; an all-unknown request is `200` with `data: []`. Max 100 items. Order not guaranteed.
- **Status codes:** 200, 400, 401, 403, 500. **Error codes:** `ValidationFailed`, `ServiceTokenRequired`,
  `InsufficientScope`, `InternalError`.
- **Idempotency-Key:** n/a (GET). **Pagination:** none (bounded batch by ids; the cursor rule applies to lists).
  **Filters:** `ids` only.
- **Evaluation order:** guard -> scope (`authorize`) -> query validation (400) -> lookup. A token without the scope gets
  `403 InsufficientScope` even when `ids` is malformed; validation never runs for an unauthorized caller. The same
  order holds for the other two routes (3.2, 3.3).
- **Logging:** the service logs `internal_users_read` with `{ clientId, requested, returned }`, counts only, both
  counted after de-duplication (D-9). Never an id list or any profile field.

### 3.2 `GET /internal/users/contacts` (`getUserContacts`)
- **Guard:** `service`. **Roles:** `[service]`. **Ownership:** `none`. **Scope:** `users:contact:read` (only the
  `care-service` client can hold it: DB `CHECK` plus provisioning scripts, ADR 0024; the module adds no extra check).
- **Policy:** `{ kind: "service", scope: "users:contact:read", owner: "none" }`.
- **Query DTO:** the same `IdsQueryDto`.
- **Response 200** (`Cache-Control: no-store`): `data: UserContact[]`, each `{ id, email, fullName, locale, status }`.
  **No phone**, ever; the SQL column list excludes it. Omission and ordering as 3.1. Soft-deleted users are omitted
  (their email is free for re-registration).
- **Status codes / error codes:** as 3.1.
- **Logging:** the access log carries route, `clientId`, status, duration (request logger). The service logs
  `internal_contacts_read` with `{ clientId, requested, returned }`, counts only, both counted after de-duplication
  (D-9). Never an address, name or id list. (The batch route logs `internal_users_read` the same way, section 3.1.)

### 3.3 `PATCH /internal/users/{id}/status` (`internalUpdateUserStatus`)
- **Guard:** `service`. **Roles:** `[service]`. **Ownership:** `none` (doctor targets only, D-3, ADR 0025). **Scope:**
  `users:status:write`.
- **Policy:** `{ kind: "service", scope: "users:status:write", owner: "none" }`.
- **Path DTO:** `id` canonical positive integer (`^[1-9][0-9]*$`, safe integer), as `UserIdParamDto`.
- **Body DTO `InternalStatusChangeDto`** (unknown properties rejected):
  - `status`: `@IsIn(["active","rejected","pending","suspended"])`.
  - `reason`: `@IsString() @IsNotBlank() @MaxLength(500)` (trimmed, 1..500, matches `chk_user_status_changes_reason_not_blank`).
  - `actorUserId`: `@IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)` (JSON number; a numeric string is a `400`).
- **Response 200:** `{ id, status, updatedAt }` (`StatusChangeResponse`). `status` is the status after the call;
  `updatedAt` is unchanged on a no-op.
- **Status codes:** 200, 400, 401, 403, 404, 409, 500. **Error codes:** `ValidationFailed`, `ServiceTokenRequired`,
  `InsufficientScope`, `NotFound`, `InvalidStatusTransition`, `InternalError`.
- **Idempotency-Key:** not used (D-8); same-status retries are the idempotency mechanism.
- **Evaluation order:** guard -> scope -> path/body validation (400) -> lock target `FOR UPDATE` (404 when absent or
  soft-deleted) -> same status (200 no-op, D-5) -> transition table (409) -> write -> commit -> 200.
- **Examples:** Case 1 `{ "status": "active", "reason": "Credentials verified", "actorUserId": 7 }` on a pending doctor;
  Case 3 `{ "status": "suspended", ... }` on an active doctor; Case 4 `{ "status": "active", ... }` on a suspended one.

## 4. Business rules

| # | Rule | Enforced in |
|---|---|---|
| BR-1 | Only a verified service token reaches these routes; a user token (any role) is `401 ServiceTokenRequired`. | `serviceGuard` (typ check) |
| BR-2 | A token without the route's scope is `403 InsufficientScope`; scopes are not interchangeable (`users:read` cannot read contacts or write status). | `authorize` service policy |
| BR-3 | No identity header is read; the only principal is the token. `actorUserId` never decides access. | guard, controller (never reads headers), service |
| BR-4 | `ids` must be 1..100 canonical positive integers; otherwise `400 ValidationFailed` with a field issue. | `IdsQueryDto` + `validateQuery` |
| BR-5 | Batch lookup and contacts return live users only; unknown and soft-deleted ids are omitted, never an error. One query, `id = ANY($1)`. | repository (`deleted_at IS NULL`, `ANY`) |
| BR-6 | The summary shape never contains email, phone or any secret; the contact shape never contains phone. | explicit column lists + response DTOs `from(...)` |
| BR-7 | Allowed service transitions are exactly `pending -> active\|rejected`, `rejected -> pending`, `active -> suspended`, `suspended -> active`; any other pair is `409 InvalidStatusTransition`. | `SERVICE_TRANSITIONS` check in `UsersService` |
| BR-8 | Setting the status the user already has is `200` with the current status, no history row, `updated_at` unchanged. | `UsersService` (compare after the row lock) |
| BR-9 | Entering `suspended` or `rejected` revokes all refresh-token families in the same transaction as the status update and history row; the response is sent only after commit. Entering `active`/`pending` revokes nothing. | `UsersService` transaction; `SessionService.revokeAllForUser(trx, ...)` |
| BR-10 | A repeated `suspended` call returns 200 and still revokes any live family; a repeated `rejected`, `active` or `pending` call changes nothing. | `UsersService` (D-5) |
| BR-11 | Every real change inserts one `user_status_changes` row (`from_status`, `to_status`, `reason`, `actor_user_id` from the body, `actor_service` from the token `sub`, `request_id`) in the same transaction; a failure of any step rolls back all of them. | `UsersService` transaction |
| BR-12 | `actorUserId` is recorded as data: no existence, role or status check can reject the call; an id that does not exist is stored as `NULL` and logged (D-6); a soft-deleted actor is recorded normally. | `UsersService` + `existsIncludingDeleted` |
| BR-13 | The target row is locked `FOR UPDATE` before any token row is touched (shared lock order with refresh rotation, ADR 0019/0020), so a refresh racing a suspension either completes first (then is revoked) or sees `suspended`. | `AccountService.lockLiveById` first in the transaction |
| BR-14 | After a Case 3 success a refresh with any previous token fails (`RefreshTokenInvalid`/`AccountSuspended`), and a login is refused (`AccountSuspended`). After a Case 1 `rejected` success refresh tokens are revoked but a new login and refresh succeed (ADR 0004). | revocation + existing auth rules |
| BR-15 | An unknown or soft-deleted target is `404 NotFound` on the status route. | `lockLiveById` returns `undefined` |
| BR-16 | The free-text `reason` is never logged; logs carry ids, statuses, counts and the enum `cause` (ADR 0021). | service logging discipline; test |
| BR-17 | These routes make no outbound call and read no Redis. A database failure is `500 InternalError`; Care retries. | design; test |
| BR-18 | The public admin route still refuses doctor targets; `suspended -> active` for a doctor exists only here (ADR 0012 as amended by 0023). | `UsersService` caller branch; users tests |
| BR-19 | The status route accepts doctor targets only: after the lock and the 404 check, a patient or admin target is `403 Forbidden` with no write, no revoke, no history row (ADR 0025). | `UsersService` caller branch (`service`), after `lockLiveById` |

### 4.1 `applyStatusChange` after this module (behaviour of the `service` caller)
1. Open one transaction; `lockLiveById` (404 if absent).
2. Resolve `current`. If `current === toStatus`: when `suspended`, `revokeAllForUser` then commit; otherwise roll back;
   return `{ id, status, updatedAt, changed: false }`.
3. If `toStatus` is not in `SERVICE_TRANSITIONS[current]`: log `status_change_refused` with `cause: "transition"` (ids
   only) and throw `InvalidStatusTransition`.
4. `updateStatus`; resolve the actor (D-6); `insertStatusChange` with `actorUserId` (or `null`), `actorService`,
   `reason`, `requestId`.
5. If `toStatus` is `suspended` or `rejected`: `revokeAllForUser(trx, id, StatusChanged)`.
6. Commit; log `user_status_changed` with `{ clientId, actorUserId, userId, from, to, revokedSessions }`; return
   `changed: true`.
The `admin` caller keeps its current behaviour (live-actor re-read, target refusals, `ADMIN_TRANSITIONS`); because
`rejected` is unreachable for admins, the shared revoke rule "suspended or rejected" is equivalent for them.

## 5. Cross-service behavior

Identity is the **provider**; Care is the caller. Details: hub `architecture/landscape.md`.

| Case | Caller -> endpoint | Failure policy |
|---|---|---|
| 1 Verification unlocks the account | Care -> `PATCH /internal/users/{id}/status` `active`/`rejected`/`pending` | idempotent; `409` is non-retryable (Care outbox row `failed`, alert); all else retried by Care. Must-not-degrade: a 200 means the status is committed. |
| 2 Batch hydration | Care -> `GET /internal/users?ids=` | Care degrades (cached or placeholder profile) when Identity is down; Identity returns omitted ids as absent. |
| 3 Suspension revokes sessions | Care -> `PATCH ... {status: suspended}` | Care retries until 200; a 200 means status, revocation and history all committed. `409` signals drift, Care alerts. |
| 4 Doctor reinstatement | Care -> `PATCH ... {status: active}` on a suspended doctor | idempotent (already `active` -> 200); `409` non-retryable. |
| 5 Notification contacts | `care-worker` -> `GET /internal/users/contacts?ids=` | Care worker retries on failure; Identity never caches or logs addresses. |

Identity makes no outbound calls on any of these paths. `X-Request-Id` from the caller is adopted (request-id middleware)
and stored in `user_status_changes.request_id`. Contract changes to `/internal/*` are breaking for Care (CLAUDE.md ->
Cross-service integration).

## 6. Error codes

All codes already exist; none is added.

| Code | HTTP | When (this module) |
|---|---|---|
| `ValidationFailed` | 400 | bad `ids` (missing, empty, non-integer, > 100, repeated key), bad path id, body DTO invalid (unknown field, blank/over-long `reason`, `actorUserId` not a positive integer, `status` outside the four values), malformed JSON |
| `ServiceTokenRequired` | 401 | missing/invalid/expired service token, wrong `aud`, a user token of any role |
| `InsufficientScope` | 403 | token lacks `users:read` / `users:contact:read` / `users:status:write` for the route |
| `Forbidden` | 403 | status route: target is not a doctor (BR-19, ADR 0025) |
| `NotFound` | 404 | status route: target absent or soft-deleted |
| `InvalidStatusTransition` | 409 | pair not in `SERVICE_TRANSITIONS` (non-retryable for the caller) |
| `InternalError` | 500 | unhandled (including database failure) |

## 7. Security & privacy

- **RBAC summary:** all three routes: `service` principal, scope-gated, ownership `none`. No user role may call them.
  Only `care-service` is provisioned with these scopes in MVP; `users:contact:read` is database-restricted to it.
- **Audit:** every real status change is a `user_status_changes` row (who, from/to, reason, `actor_service`,
  `request_id`). Logs: `user_status_changed`, `status_change_refused`, `status_change_actor_unknown`,
  `internal_users_read`, `internal_contacts_read` (both `{ clientId, requested, returned }`, counted after
  de-duplication, counts only), plus the access log; metrics via log-derived counters (ADR 0013): count of status changes by
  `to` and of `status_change_refused`.
- **Never logged:** the service token, `Authorization`, any email, name, phone, the contacts payload, the status `reason`
  (free text, ADR 0021), `ids` lists of contacts requests. Do not pass them to the logger; the redactor is defence in depth.
- **PII exposure:** the batch lookup has none beyond display profile; the contacts endpoint carries email, is
  `no-store`, single-purpose and single-caller (ADR 0024).
- **Rate limits:** none on these routes (D-8); the token endpoint (30/min per IP, 60/min per client) bounds credential
  abuse, and the 300 s TTL bounds a leaked token.
- **Residual risk (accepted, ADR 0002/0023):** a disabled client's token works for up to 300 s; a status change cannot
  revoke access tokens already issued (<= 15 min); `users:status:write` is limited to doctor targets (D-3, ADR 0025).
- No files, no uploads.

## 8. Performance

| Path | Queries | Index | Budget (p95) |
|---|---|---|---|
| `GET /internal/users` (100 ids) | 1 | PK `ANY` | < 50 ms |
| `GET /internal/users/contacts` (100 ids) | 1 | PK `ANY` | < 50 ms |
| `PATCH .../status` | 1 `FOR UPDATE` read, 1 update, 0-1 actor existence read, 1 history insert, 0-1 revoke update; one transaction | PK, `user_status_changes` PK, refresh-tokens user index | < 50 ms |

No N+1 (batch with `= ANY`), no `SELECT *`, no outbound calls, no argon2 and no Redis on these paths. `EXPLAIN` the two
lookups and the revoke update before merging; revoking a user with many families is a single `UPDATE`. The guard performs
no I/O, so authentication adds no database round trip.

## 9. Test plan outline

### 9.1 Unit (`tests/unit/`, mock collaborators)
- `should expose exactly the four service transitions when SERVICE_TRANSITIONS is read` (BR-7, table equality).
- `should reject ids when the list is empty, over 100, contains a non-integer or a leading zero` (BR-4); `should collapse duplicate ids` (D-9).
- `should return no-op without writing when the status is unchanged` (BR-8); `should revoke when already suspended` (BR-10); `should not revoke when already rejected`.
- `should throw Forbidden without writing when the service caller targets a non-doctor` (BR-19).
- `should store a NULL actor and log when the actor id does not exist` (BR-12); `should not call the actor check for the admin caller`.
- `should revoke for suspended and rejected only` (BR-9); `should throw InvalidStatusTransition for each invalid pair` (BR-7).
- `should roll back everything when the history insert or revoke fails` (BR-11, atomicity with a failing collaborator).
- `should not pass reason or email to the logger` (BR-16).
- Response DTOs: summary has no `email`/`phone`; contact has no `phone` (BR-6).
- Controller and policies: each policy names its scope and `owner: "none"`; the internal app boot check passes (`assertRoutesAuthorized`).

### 9.2 Integration (`tests/integration/internal-users/`, real Postgres and Redis, nothing mocked)
- Contract conformance for the three operations: statuses, error codes, shapes from `contracts/openapi.yaml`.
- `GET /internal/users`: returns summaries for known ids and omits unknown and soft-deleted ones; 100 ids ok, 101 -> 400; `ids` missing/empty/garbage -> 400; response has no email/phone key at all.
- `GET /internal/users/contacts`: returns email and no phone; `no-store`; `users:read` token -> 403; unknown/deleted omitted; > 100 -> 400.
- RBAC matrix per route: no token -> 401; user token (patient, doctor, admin) -> 401 `ServiceTokenRequired`; service token with another scope -> 403; correct scope -> 200 (BR-1, BR-2, BR-3: `X-User-Id`/`X-Role` headers have no effect).
- Case 1: pending doctor -> `active` (200, one history row with `actor_service = care-service`, `actor_user_id`, the request id); `-> rejected` revokes tokens, then a new login succeeds and its refresh works (BR-14); `rejected -> pending` ok.
- Case 3: suspend an active doctor with two live families -> 200, all families revoked with `status_changed`, a refresh with an old cookie fails, login returns `AccountSuspended`; repeat call -> 200, no new history row; suspended with a live token (inserted directly) is revoked by the repeat (BR-10).
- Case 4: suspended doctor -> `active` -> 200, history row, old tokens stay revoked, login works; repeat -> 200 no new row; `PATCH /api/users/:id/status` on the doctor still `403 Forbidden` (BR-18).
- `409 InvalidStatusTransition` for each invalid pair (e.g. `active -> pending`, `active -> rejected`, `pending -> suspended`, `rejected -> active`, `suspended -> rejected`) and no row, no revoke, no status change.
- `404 NotFound` for unknown and soft-deleted targets.
- `403 Forbidden` for a patient target and for an admin target, every status value: no status change, no history row, no revoke (BR-19).
- `actorUserId` for a deleted user is recorded; for a non-existent id the call is 200 and `actor_user_id` is NULL (BR-12); a patient actor id is accepted (data, not authority).
- Atomicity: force the revoke step to fail (test hook at the repository seam is not allowed; use a DB-level failure such as a trigger created in the test) and assert status and history are unchanged.
- Concurrency: a refresh racing a suspension ends with the family revoked and no live token (BR-13).
- Body validation: unknown field, blank `reason`, 501-char `reason`, string `actorUserId`, bad `status` -> 400.
- Logs: after a status call the captured log lines contain no `reason` text, email or token (BR-16).
- No secret or hash appears in any response body.
- Redis down: the three routes still work (BR-17).

### 9.3 Manual QA (`/manual-qa internal-users`)
CURL against the internal port with a token from `POST /internal/auth/token`; compare with contract codes.

## 10. Out of scope
- Provisioning clients, scopes, token issuance (service-auth module and runbook).
- Admin MFA and finer per-target authorization beyond the doctor-only check (ADR 0025).
- Events (`user.status_changed`), webhooks, or push to Care; MVP is HTTP pull/push by Care only.
- A bulk status endpoint; email or phone in the batch lookup; contacts for any client other than `care-service`.
- Hard delete, PII anonymization (ADR 0011), email change.
- Pagination on the lookups (bounded by the 100-id cap).
- Care's retry, caching and alerting behaviour (Care's repo).

## 11. Open questions

None. Decisions D-1..D-10 resolve every ambiguity found while reading the contract, ADRs and built modules. Contract
changes required: none (the three operations already exist and match). The optional clarifications listed in section
12 are non-breaking description edits, not blockers.

## 12. Accepted follow-ups

> Applied 2026-10-08 by `/update-docs internal-users`: 12.1 (duplicate and cap wording for both lookups in the
> contract; the 403 of the status route now names `InsufficientScope` and `Forbidden`) and 12.3. The `actorUserId`
> sentence of 12.1 was already in the contract.

### 12.1 Optional contract wording (non-breaking, apply in `/develop` step 0 or `/update-docs`)
- `internalUpdateUserStatus` description: add one sentence that an `actorUserId` that does not exist is recorded as
  `NULL` rather than rejected (D-6), and that a repeated `suspended` call re-asserts revocation (already stated).
- `batchGetUsers` / `getUserContacts`: state that duplicate ids are accepted and collapsed and that the 100 cap counts
  entries as sent (D-9).

### 12.2 Platform follow-ups
None. No hub document changes: cases 1-5, the scopes and the data ownership are already recorded there (hub ADR 0009,
0010).

### 12.3 Docs to refresh after build
`docs/service-card.md` (endpoints, status of `internal-users`, `users:contact:read`), `docs/architecture/api.md`,
`docs/architecture/service-auth.md` (scope table), `docs/INDEX.md` status banner, `docs/runbook.md` (Case 3 stuck
retries, reinstatement now via Care).

## 13. As-built notes (2026-10-08, version 1.0.1)
Intentional divergences from, or additions to, version 1.0.0; the code is the reference.
- **Log event names.** The contacts event is `internal_contacts_read` (was `contacts_looked_up` in 1.0.0); the batch route
  logs `internal_users_read`. Both carry `{ clientId, requested, returned }`, counted after de-duplication (D-9), emitted
  by `InternalUsersService`, never by the controller.
- **Scope before validation.** `authorize(policy)` runs before the DTO validation on all three routes, so a missing
  scope is `403 InsufficientScope` regardless of the input (sections 3.1 to 3.3). Pinned by the RBAC integration tests.
- **Cache headers.** `GET /internal/users` sends no `Cache-Control` (no PII; the contract declares none). Contacts and the
  status PATCH are `Cache-Control: no-store` (D-10).
- **Migration dependency.** Issuing `users:contact:read` needs migration `20261008000100`; a database without it cannot
  provision `care-service` with the scope (manual QA N-1).
- **Refresh after suspension** returns `401 RefreshTokenInvalid` (the family is already revoked), not `403 AccountSuspended`;
  BR-14 allows either (manual QA N-3).
