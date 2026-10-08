---
title: users — Spec
owner: identity-team
service: identity-service
module: users
status: ready
version: 1.0.1
diataxis: reference
last_verified: 2026-10-07
tags: [spec, users, admin, account-status, status-history, sessions, lock-order, rbac]
related: [users-brainstorm, users-tasks, auth-spec, data-model, api, auth-tokens, adr-0002-asymmetric-jwt-rotating-refresh, adr-0004-rejected-doctors-can-sign-in, adr-0005-refresh-reuse-grace-window, adr-0010-manual-admin-provisioning-role-policies, adr-0011-pii-retained-on-soft-delete, adr-0012-doctor-status-only-via-care, adr-0019-refresh-versus-suspension-lock-order, adr-0020-refresh-rotation-versus-revocation-lock-order]
contracts: [contracts/openapi.yaml]
---

# users — Spec

Source of truth for the HTTP shape is [`contracts/openapi.yaml`](../../contracts/openapi.yaml) (tag `users`, five
operations, all already applied). On any disagreement the contract wins and this spec is stale.
Built **after** `auth` (as-built, see [auth/spec.md](../auth/spec.md)). Intent: [brainstorm.md](./brainstorm.md).

## 1. Overview

### 1.1 What the module owns
- Admin account management on the public API: `GET /api/users`, `GET /api/users/{id}`,
  `PATCH /api/users/{id}/status`, `GET /api/users/{id}/sessions`, `DELETE /api/users/{id}/sessions`.
- The table `user_status_changes` (append-only status history) and its repository.
- The **status-transition service method** (domain rule 3) that Epic B's `PATCH /internal/users/{id}/status` will
  call through `UsersService` (never through a repository).
- The **joint lock-order change** of ADR 0019 / ADR 0020 across `UsersService` and the auth `SessionService`
  (section 1.5 and 3.8): this unit edits `SessionService` (`rotate`, `logout`, reuse-detection revoke) in the same
  change so every writer and the refresh hot path lock in one order.

### 1.2 Principles
- Admin only: every route has `roles: ["admin"]`, `owner: "none"`, and the account-state requirement `active`.
- Clinical data: none. `User` carries email and phone, which admins may see by contract; never a password hash,
  token hash, or any secret.
- Deny first, reveal little: a missing or soft-deleted target is `404 NotFound`; role/self checks on the status route
  are `403 Forbidden` and run **before** the transition check and write nothing.
- One transaction per mutation; the **user row is locked first** (`FOR UPDATE`), always.
- Soft-deleted users are never listed, read, or acted on.

### 1.3 Dependencies
- **auth (as-built):** `users` table, `User` entity, `userGuard`, `authorize`, `UserResponseDto`, `SessionService`,
  `AccountService`, `lib/http/pagination`, `lib/validation`, `Clock`, request context (`requestId`).
- **Other service:** none (no outbound calls; Care is unaffected). Epic B will depend on this module.

### 1.4 Module boundaries (decisions)
- **D-1 Shared transition code lives in `UsersService`** (resolves brainstorm Q1): one method
  `applyStatusChange(command)` where `command.caller` is a union `{ kind: "admin", actorUserId }` |
  `{ kind: "service", actorService, actorUserId }`. This unit implements and wires only the `admin` caller with
  its transition table `ADMIN_TRANSITIONS` (`active -> suspended`, `suspended -> active`) and the target rules
  (patient only, not self). `internal-users` adds `SERVICE_TRANSITIONS` and its target rules in its own spec; the
  union and the lock-order skeleton are shared so it cannot diverge. Transition tables are pure constants in
  `src/app/users/status-transitions.ts`.
- **D-2 `users` table access** goes through `AccountService` (auth spec section 1.4). This unit adds to
  `user.repo.ts` and `AccountService`: `listLive`, `findLiveByIdForUpdate` exposure (already in the repo), and
  `updateStatus`. No `users` module code imports `user.repo.ts` directly.
- **D-3 `refresh_tokens` access** goes through `SessionService`: this unit adds `listLiveFamilies` and keeps using
  `revokeAllForUser(conn, userId, reason)`. The users module never imports `refresh-token.repo.ts`.
- **D-4 `user_status_changes` is owned here:** `src/app/users/repository/user-status-change.repo.ts`, insert-only
  in this unit (history is written, not exposed over the API in MVP).
- **D-5 Mutations re-read the acting admin.** The policy checks only the token's `status` claim (<= 15 min stale).
  `PATCH .../status` and `DELETE .../sessions` additionally read the live actor row (`AccountService.findLiveById`,
  primary key, before the transaction, no lock): absent -> `401 Unauthorized`, `suspended` -> `403 AccountSuspended`.
  Same precedent as auth BR-24. Read routes rely on the claim (residual accepted, ADR 0002).
- **D-6 Lock mode in `rotate` is `FOR SHARE`** (ADR 0019 / users task), revokers use `FOR UPDATE`. ADR 0020 words
  the uniform plan as `FOR UPDATE`; `FOR SHARE` in `rotate` conflicts with every `FOR UPDATE` / row update on the
  user, so it satisfies the same exclusion while letting a user's concurrent refreshes on different devices run in
  parallel. See section 3.8 for the exact steps; the refinement is noted in ADR 0020 (2026-10-07).

### 1.5 File list
```
src/app/users/
  controller/users.controller.ts
  service/users.service.ts
  repository/user-status-change.repo.ts
  entity/user-status-change.entity.ts
  dto/users.request.dto.ts        # ListUsersQueryDto, ListSessionsQueryDto, UserIdParamDto, AdminStatusChangeDto
  dto/users.response.dto.ts       # SessionResponseDto, StatusChangeResponseDto (UserResponseDto reused from auth)
  enums.ts  errors.ts  types.ts  policies.ts  routes.ts  status-transitions.ts
src/app/auth/                      # edited in this unit
  repository/user.repo.ts          # + listLive, findLiveByIdForShare, updateStatus
  repository/refresh-token.repo.ts # + listLiveFamilies
  service/account.service.ts       # + listLive, lockLiveById, updateStatus
  service/session.service.ts       # + listLiveFamilies; rotate / logout / reuse-revoke lock order
src/lib/http/pagination/           # + key-cursor helpers (section 3.7)
src/migrations/20261007000100_create_user_status_changes.ts
src/migrations/20261007000200_add_users_list_and_session_indexes.ts
src/routes.ts, src/bootstrap.ts, src/lib/di/tokens.ts   # mount /users, register UsersService + UsersController
```
Module files follow CLAUDE.md -> Module file conventions. `UserResponseDto` is imported from the auth module's DTO
file (a DTO, not a repository); no new copy is made.

## 2. Database schema

### 2.1 `20261007000100_create_user_status_changes.ts`
Raw SQL, real `down` (`DROP TABLE IF EXISTS user_status_changes`). Matches
[data-model.md](../architecture/data-model.md) -> `user_status_changes`.

| Column | Type | Null | Constraint |
|---|---|---|---|
| `id` | `BIGSERIAL` | no | `PRIMARY KEY` |
| `user_id` | `BIGINT` | no | `fk_user_status_changes_user_id` -> `users(id)` |
| `from_status` | `VARCHAR(16)` | no | `chk_user_status_changes_from_status` `IN ('pending','active','suspended','rejected')` |
| `to_status` | `VARCHAR(16)` | no | `chk_user_status_changes_to_status` (same set); `chk_user_status_changes_differs` `from_status <> to_status` |
| `actor_user_id` | `BIGINT` | yes | `fk_user_status_changes_actor_user_id` -> `users(id)` |
| `actor_service` | `VARCHAR(64)` | yes | service token `sub`; null on the public admin route |
| `reason` | `VARCHAR(500)` | no | `chk_user_status_changes_reason_not_blank` `length(btrim(reason)) > 0` |
| `request_id` | `UUID` | no | the request's `X-Request-Id` |
| `created_at` | `TIMESTAMPTZ` | no | `DEFAULT now()` |

Also `chk_user_status_changes_actor`: `actor_user_id IS NOT NULL OR actor_service IS NOT NULL`. No `deleted_at`,
no `updated_at`: an append-only audit table, never purged and never updated (data-model.md -> Retention). No default
on any status column.

Indexes (each with a comment naming its query, as in the auth migrations):
- `idx_user_status_changes_user_id_created_at (user_id, created_at DESC)` — status history of one user (support
  investigation; written now, read by ops SQL and a future admin route); covers `fk_user_status_changes_user_id`.
- `idx_user_status_changes_actor_user_id (actor_user_id) WHERE actor_user_id IS NOT NULL` — "what did this admin
  change" audit; covers `fk_user_status_changes_actor_user_id`.

### 2.2 `20261007000200_add_users_list_and_session_indexes.ts`
Additive indexes on tables owned by `auth` (auth spec section 1.4 assigns these to this unit). `down` drops each.

| Index | Definition | Query it serves |
|---|---|---|
| `idx_users_created_at_id` | `(created_at DESC, id DESC) WHERE deleted_at IS NULL` | `GET /api/users` default page, no filter |
| `idx_users_role_created_at_id` | `(role, created_at DESC, id DESC) WHERE deleted_at IS NULL` | `GET /api/users?role=` |
| `idx_users_status_created_at_id` | `(status, created_at DESC, id DESC) WHERE deleted_at IS NULL` | `GET /api/users?status=` |
| `idx_refresh_tokens_user_id_live` | `(user_id) WHERE revoked_at IS NULL` | `GET /api/users/{id}/sessions`: live tokens of one user (replaces a scan of every rotated row of the user) |
| `idx_refresh_tokens_family_id_created_at` | `(family_id, created_at, id)` | session `createdAt`: the earliest retained token of a family, `ORDER BY created_at, id LIMIT 1` |

Notes: `?email=` uses the existing `uq_users_email`. `?role=&status=` together uses `idx_users_role_created_at_id`
with a residual `status` filter (no combined index: not a measured need; admin lists are low-volume).
`idx_refresh_tokens_user_id_created_at` (auth) remains for `revokeAllForUser`.

### 2.3 Timestamp ownership
`users.updated_at` is set to `now()` by `updateStatus` on a real change only. `user_status_changes.created_at` is the
database default. All `TIMESTAMPTZ`.

## 3. Module internals

### 3.1 `enums.ts`
`StatusCaller` kinds: `Admin = "admin"`, `Service = "service"`. `UserStatus`/`UserRole`/`RevokedReason` are reused
from auth enums. (`status_changed` and `admin_revoked` already exist in `chk_refresh_tokens_revoked_reason`.)

### 3.2 `errors.ts`
```
TargetIsSelf        = new AppError("Forbidden", 403, "You cannot change your own account status")
TargetIsAdmin       = new AppError("Forbidden", 403, "You cannot change another admin's account status")
TargetIsDoctor      = new AppError("Forbidden", 403, "Doctor account status is managed by care-service")
InvalidStatusTransition = new AppError("InvalidStatusTransition", 409, "Status change is not allowed")
```
All reuse existing codes; `NotFound`, `Unauthorized`, `AccountSuspended` come from `lib/error/errors`. The
`InvalidStatusTransition` message matches the contract example; `details` stays empty (no per-field cause; the
current and requested statuses are not echoed).

### 3.3 `types.ts`
`StatusChangeCaller` (union of D-1), `StatusChangeCommand { targetId, toStatus, reason, caller, requestId }`,
`StatusChangeResult { id, status, updatedAt, changed }`, `UserListFilter { role?, status?, email? }`,
`UserCursor`, `SessionRow`, `SessionView`, `NewStatusChange`, `UserStatusChangeRow`.

### 3.4 Entity
`UserStatusChange` (plain class, `constructor(data: Partial<UserStatusChange>)`): id, userId, fromStatus, toStatus,
actorUserId, actorService, reason, requestId, createdAt. Sessions are a read model (`SessionView`), not an entity.

### 3.5 Request DTOs (`dto/users.request.dto.ts`; `forbidNonWhitelisted`)
- `UserIdParamDto { id }` — `@Type(() => Number) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)`. Applied to every
  `:id` route; a non-numeric or `< 1` id is `400 ValidationFailed` (field `id`).
- `ListUsersQueryDto extends PaginationQueryDto { role?, status?, email? }` — `role` `@IsIn(roles)`, `status`
  `@IsIn(statuses)`, `email` `@IsEmail() @MaxLength(254)` (lowercasing is unnecessary: the column is `CITEXT`).
  Any other query parameter is rejected (`is not allowed`).
- `ListSessionsQueryDto extends PaginationQueryDto` — `cursor`, `limit` only.
- `AdminStatusChangeDto { status, reason }` — `status` `@IsIn(["active","suspended"])` (other valid statuses such as
  `pending`/`rejected` are `400`, exactly the contract enum); `reason` `@IsString() @MinLength(1) @MaxLength(500)`
  plus a not-blank check (`@Matches(/\S/)`, consistent with `chk_user_status_changes_reason_not_blank`).
- `DELETE` and `GET /users/{id}` take no body; a body on `DELETE` is ignored.

### 3.6 Response DTOs (`dto/users.response.dto.ts`)
Controllers return only these. Not viewer-aware: no clinical data; the single viewer is an admin.
- `UserResponseDto` (auth): `id, email, phone, fullName, avatarUrl, role, status, emailVerifiedAt, timezone, locale,
  createdAt, updatedAt` — contract `User`. No `passwordHash`, no `deletedAt`.
- `SessionResponseDto`: `familyId, deviceInfo, createdAt, lastUsedAt, expiresAt` (ISO UTC) — contract `Session`.
  Never a token value, hash, token id, or user id.
- `StatusChangeResponseDto`: `id, status, updatedAt` — contract `StatusChangeResponse`.

### 3.7 Repositories (functions, `conn: Knex = db`, explicit column lists, no `SELECT *`)
**`user.repo.ts` additions (auth-owned file, listed in D-2)**
- `listLive(filter, cursor, limit, conn)` — `SELECT <USER_COLUMNS>, to_char(created_at AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor FROM users WHERE deleted_at IS NULL [AND role = $1] [AND
  status = $2] [AND email = $3] [AND (created_at, id) < ($4::timestamptz, $5)] ORDER BY created_at DESC, id DESC
  LIMIT limit + 1`. The cursor value is the **microsecond-precision text** of `created_at`: a JS `Date` truncates to
  milliseconds, which would skip or repeat rows on page 2 whenever two rows share a millisecond.
  Indexes: section 2.2 and `uq_users_email`. `password_hash` is selected because `toEntity` needs the full column
  list (single mapper); the response DTO never reads it.
- `findLiveByIdForShare(id, trx)` — `... WHERE id = $1 AND deleted_at IS NULL FOR SHARE`. Used by `rotate` only.
- `findLiveByIdForUpdate(id, trx)` already exists (login and change-password) and is reused.
- `updateStatus(id, status, trx)` — `UPDATE users SET status = $2, updated_at = now() WHERE id = $1 AND deleted_at
  IS NULL RETURNING <USER_COLUMNS>`; returns the entity or `undefined`.

**`refresh-token.repo.ts` addition**
- `listLiveFamilies(userId, now, cursor, limit, conn)`:
  one live token per family (a duplicate under a residual race is collapsed with `DISTINCT ON (family_id) ... ORDER BY
  family_id, created_at DESC, id DESC`), restricted to `user_id = $1 AND revoked_at IS NULL AND expires_at > $now`
  (index `idx_refresh_tokens_user_id_live`); each joined `LATERAL` to the family's earliest retained token
  (`SELECT created_at FROM refresh_tokens WHERE family_id = l.family_id ORDER BY created_at, id LIMIT 1`, index
  `idx_refresh_tokens_family_id_created_at`) as `first_created_at`. Projection: `family_id`, `device_info`,
  `first_created_at` (as microsecond text for the cursor and as `Date`), `created_at AS last_used_at`, `expires_at`.
  Order and keyset: `ORDER BY first_created_at DESC, family_id ASC` with predicate
  `(first_created_at < $c) OR (first_created_at = $c AND family_id > $f)` (the contract's
  `(created_at DESC, family_id)`). `LIMIT limit + 1`. The set is bounded by the user's live logins, so sorting after
  the index scan is acceptable; no extra index for the computed sort.

**`user-status-change.repo.ts`**
- `insertStatusChange(row: NewStatusChange, trx)` — inserts one row and returns its id. No update or delete
  function exists (append-only).

**`lib/http/pagination` additions** (resolves brainstorm Q3): the shared cursor requires a positive integer `id`, so
the sessions cursor, whose tiebreaker is the family UUID, uses new helpers `encodeKeyCursor({ v: string, k: string })`
and `decodeKeyCursor(cursor)` (validates `v` as an ISO-8601 instant with up to 6 fractional digits and `k` as a UUID;
any failure is `400 ValidationFailed` field `cursor`, same as the existing decoder). The user list keeps the existing
`encodeCursor/decodeCursor(cursor, "iso-timestamp")` with `v` = the microsecond text and `id` = the numeric user id.
Adding a helper is not a new dependency (no ADR).

### 3.8 Services, transactions, and the lock order (ADR 0019 / ADR 0020)

**Global lock order.** For one user: **`users` row first, then that user's `refresh_tokens` rows, never the reverse.**
Writers (status change, admin revoke, reset, change-password, logout, reuse-detect revoke, login) lock the user row
`FOR UPDATE` (or take the equivalent row write lock on `users`). The refresh hot path locks it `FOR SHARE`. Two
`FOR SHARE` holders coexist; `FOR SHARE` conflicts with every `FOR UPDATE`/`UPDATE`, so a rotation and a revocation of
the same user are fully serialised, and because both acquire user-then-token no deadlock cycle exists.

**`UsersService` (`@injectable()`)**

`getUser(id)` -> `AccountService.findLiveById(id)`; `undefined` -> `NotFound`.

`listUsers(filter, cursor, limit)` -> `AccountService.listLive`; `buildPage`.

`listSessions(userId, cursor, limit)`: `findLiveById(userId)` (404 if absent) -> `SessionService.listLiveFamilies`;
`buildPage` with the key-cursor. A suspended target has no live families and returns an empty page (not an error).

`revokeSessions(actorUserId, targetId)`:
1. `AccountService.findLiveById(actorUserId)` (D-5).
2. `trx = db.transaction()`; `AccountService.lockLiveById(trx, targetId)` (`FOR UPDATE`); `undefined` -> rollback,
   `NotFound`.
3. `SessionService.revokeAllForUser(trx, targetId, RevokedReason.AdminRevoked)`.
4. commit; log `admin_sessions_revoked` `{ actorUserId, userId, revokedSessions }`. `204`. Any target role, including
   the caller itself, is allowed (contract has no role restriction here).

`applyStatusChange(command)` (admin caller wired here):
1. Admin caller: D-5 live actor re-read (before the transaction).
2. `trx = db.transaction()`; **lock the target**: `AccountService.lockLiveById(trx, targetId)` (`FOR UPDATE`).
   `undefined` -> rollback, `NotFound`.
3. Caller/target rules, evaluated before anything is written, in this order:
   - `target.id === caller.actorUserId` -> `Forbidden` (self);
   - `target.role === admin` -> `Forbidden` (another admin);
   - `target.role === doctor` -> `Forbidden` (ADR 0012);
   (only `patient` continues; these are three distinct messages, one code.)
4. `target.status === command.toStatus` -> rollback (nothing written), return `{ changed: false, id, status,
   updatedAt: target.updatedAt }` -> `200`. No history row, no `updated_at` bump, no revocation.
5. `ADMIN_TRANSITIONS[target.status]` must include `toStatus`, else rollback, `InvalidStatusTransition` (`409`).
   (E.g. a patient with a legacy `pending` or `rejected` status cannot be suspended through this route.)
6. `AccountService.updateStatus(trx, id, toStatus)`; `0`/`undefined` (deleted meanwhile — impossible under the lock,
   but never ignored) -> throw `InternalError`-mapped plain `Error` so the transaction rolls back.
7. `insertStatusChange` `{ userId, fromStatus, toStatus, actorUserId: caller.actorUserId, actorService: null, reason,
   requestId }` (`requestId` from the request context, always a UUID).
8. If `toStatus === suspended`: `SessionService.revokeAllForUser(trx, id, RevokedReason.StatusChanged)`.
9. commit; log `user_status_changed` `{ actorUserId, userId, from, to, revokedSessions }` (ids and statuses only;
   `reason` never logged). Return `{ changed: true, id, status, updatedAt }`.

Steps 2-8 are one transaction: either the status, the history row and the revocation all commit, or none do.

**`SessionService` changes (auth module, this unit — ADR 0019 / 0020)**

`refresh()` continues to read the presented row by hash without a lock and apply the rate limit and cheap checks
unchanged. `rotate(row)` now receives the row (it already knows `userId`) and runs:
1. `trx = db.transaction()`.
2. `users.findLiveByIdForShare(row.userId, trx)`; `undefined` (soft-deleted) -> rollback, `invalid`.
3. `refreshTokens.findByIdForUpdate(row.id, trx)`; absent -> rollback, `invalid`.
4. **Re-check under both locks:** `revokedAt !== null` -> rollback, `judgeRevoked(...)` (typically `grace` or
   `invalid`); expired (`isPast(expiresAt, now)`) -> rollback, `invalid`. The user read in step 2 is the current row
   (it cannot change while the share lock is held), so `isSuspended()` is judged on fresh data.
5. `suspended` -> `revokeFamily(familyId, StatusChanged, trx)`, commit, outcome `suspended` (unchanged behavior).
6. Otherwise insert the successor, `markRotated` (must affect 1 row), sign, commit (unchanged).

`logout(presented)`: resolve the row by hash (no lock) -> in a transaction `findLiveByIdForUpdate(row.userId)` (user
gone -> nothing to revoke, return) -> `revokeFamily(familyId, Logout, trx)` -> commit. Still never fails the request.

`judgeRevoked` reuse-detection branch: the family revoke (`ReuseDetected`) runs in a transaction that first locks the
user `FOR UPDATE`, for the same reason (otherwise a concurrent rotation of the live successor can leave a refreshable
token on a family declared compromised). The grace-window branch reads only and takes no lock.

`resetPassword` already updates the `users` row before `revokeAllForUser` (row write lock first) and
`changePassword` locks `FOR UPDATE` explicitly; both conform to the global order and are only covered by new tests.
`login` locks the user `FOR UPDATE` before inserting its token; conforming.

Performance: `FOR SHARE` on a primary-key row adds one indexed statement to refresh; budget p95 < 50 ms is
re-measured (section 10).

`SessionService.listLiveFamilies(userId, cursor, limit)` wraps the repository function with the injected `Clock`.

**Where it is enforced.** DB: FKs, `CHECK`s on history; transaction + row locks: atomicity and ordering; service:
role/self/transition rules; guard + `authorize`: role and account state.

### 3.9 DI
`TOKENS.UsersService`, `TOKENS.UsersController` (`Symbol.for(...)`); registered in `bootstrap.ts` only.
`UsersService` injects `Db`, `Logger`, `AccountService`, `SessionService`, `Clock`.

## 4. API contract

All routes: `userGuard` -> `authorize(adminUsersPolicy)` -> handler. No idempotency middleware (the contract lists no
`Idempotency-Key` for these operations; `PATCH` to the same status is naturally idempotent and `DELETE` is idempotent
by definition). No rate limiter is specified for these admin routes (see Security 9.4). Mounted at `/users` under
`/api` in `src/routes.ts`.

**Policy** (`policies.ts`), one object for all five routes:
`adminUsersPolicy = { kind: "user", roles: [UserRole.Admin], owner: "none", allowedStatuses: [UserStatus.Active] }`.
Patient and doctor -> `403 Forbidden`; admin with a `suspended` claim -> `403 AccountSuspended`; admin with
`pending`/`rejected` claim -> `403 Forbidden`; no/invalid token -> `401 Unauthorized`; expired -> `401 TokenExpired`.
Ownership is `none` (an admin acts on any user); the only per-target rules are the status-route rules in 3.8.

### 4.1 `GET /api/users` — `listUsers`
- Guard `user`; roles `admin`; ownership `none`.
- Query: `cursor`, `limit` (1..100, default 20), `role`, `status`, `email` (3.5). Sort `(created_at DESC, id DESC)`.
- `200`: `data: User[]`, `meta: { nextCursor, hasMore, count }`. Fetches `limit + 1`.
- Errors: `400 ValidationFailed` (bad filter value, bad/oversized cursor, `limit` out of range, unknown parameter),
  `401`, `403 Forbidden`, `403 AccountSuspended`, `500`.
- An `email` filter that matches no live account returns an empty page (`200`), not `404`.

### 4.2 `GET /api/users/{id}` — `getUserById`
- Guard `user`; roles `admin`; ownership `none`. `200`: `data: User`.
- Errors: `400` (bad id), `401`, `403`, `404 NotFound` (absent or soft-deleted), `500`.

### 4.3 `PATCH /api/users/{id}/status` — `updateUserStatus`
- Guard `user`; roles `admin`; ownership `none` with target rules (patients only; not self, not another admin, not a
  doctor).
- Body `AdminStatusChangeRequest`: `{ status: "active" | "suspended", reason: string (1..500) }`.
- `200`: `data: { id, status, updatedAt }` for a real change and for the no-op (same status).
- Errors: `400 ValidationFailed` (bad id, `status` not in the enum, empty/blank/oversized `reason`, unknown or missing
  field), `401`, `403 Forbidden` (self / admin / doctor target), `403 AccountSuspended`, `404 NotFound`,
  `409 InvalidStatusTransition`, `500`.
- Evaluation order: validate -> guard/authorize -> live-actor re-read -> lock target (404) -> role/self rules (403)
  -> same status (200 no-op) -> transition table (409) -> write.

### 4.4 `GET /api/users/{id}/sessions` — `listUserSessions`
- Guard `user`; roles `admin`; ownership `none`.
- Query: `cursor`, `limit`. Sort `(createdAt DESC, familyId ASC)`; cursor from the key-cursor helpers.
- `200`: `data: Session[]`, `meta`. One element per live family (a live token not revoked and not expired).
- Errors: `400`, `401`, `403`, `404 NotFound` (target absent or soft-deleted), `500`.

### 4.5 `DELETE /api/users/{id}/sessions` — `revokeUserSessions`
- Guard `user`; roles `admin`; ownership `none`.
- `204`, no body. Idempotent: a user with no live sessions still returns `204`.
- Errors: `400`, `401`, `403`, `404 NotFound`, `500`. No `409`.

Every response carries `X-Request-Id`. Responses carrying PII (`User`) are sent with `Cache-Control: no-store`
(contract change C-1, additive).

## 5. Business rules

| # | Rule | Enforced by |
|---|---|---|
| BR-1 | Every route requires `role=admin` and claim `status=active`; patient/doctor -> `403 Forbidden`, suspended admin -> `403 AccountSuspended`. | `authorize(adminUsersPolicy)` |
| BR-2 | Mutating routes re-check the live actor: soft-deleted actor -> `401`, suspended actor -> `403 AccountSuspended`. | `UsersService` (D-5) |
| BR-3 | Soft-deleted users are never listed, read, or acted on; absent and soft-deleted targets are `404`. | repository `deleted_at IS NULL` on every query |
| BR-4 | The status route changes **patients only**: self, another admin, or a doctor target -> `403 Forbidden`, checked before the transition, no write, no history row. | service (3.8 step 3) |
| BR-5 | Admin transitions are exactly `active -> suspended` and `suspended -> active`; every other pair (including `pending`/`rejected` patients) -> `409 InvalidStatusTransition`. | `ADMIN_TRANSITIONS` + service |
| BR-6 | Setting the current status again is `200`, no history row, no `updated_at` change, no revocation. | service |
| BR-7 | Each real change inserts one `user_status_changes` row (`user_id, from_status, to_status, actor_user_id` = caller, `actor_service` null, `reason`, `request_id`) in the same transaction as the update. | transaction + `chk_` constraints |
| BR-8 | Entering `suspended` revokes **all** the target's refresh-token families (`status_changed`) in the same transaction; a following refresh fails with `401 RefreshTokenInvalid` (the family is already revoked; `403 AccountSuspended` occurs only for a refresh that was waiting on the user lock when the status changed) and login is refused. | transaction (`revokeAllForUser`) |
| BR-9 | Reinstating `suspended -> active` revokes nothing, leaves no session, and the patient can log in again. | service; auth login |
| BR-10 | **Lock order (ADR 0019/0020):** status change and admin revoke lock the user row `FOR UPDATE` first, then update, write history, then revoke tokens; `rotate` reads the token's `user_id` without a lock, locks the user `FOR SHARE`, then the token `FOR UPDATE`, then re-checks the token (unrevoked, unexpired) and the user's status. No code path locks a token row before the user row. | transaction structure; concurrency tests |
| BR-11 | After a suspension or admin revoke commits, **no refreshable token** exists for the user, including a successor created by a refresh racing with it. | BR-10 |
| BR-12 | Logout and reuse-detection revocation take the same user-first lock, so no refreshable successor survives them either (ADR 0020). | `SessionService` |
| BR-13 | `DELETE /users/{id}/sessions` revokes every live family with reason `admin_revoked`; it is idempotent; any existing target (including the caller) is allowed. | service |
| BR-14 | A session is one **live** family: it has a token with `revoked_at IS NULL` and `expires_at > now`. `lastUsedAt` and `expiresAt` come from the live token, `deviceInfo` from it, `createdAt` from the earliest retained token of the family. Token values, hashes and ids are never returned. | repository + response DTO |
| BR-15 | Lists are keyset-paginated with a stable, duplicate-free page 2; cursors carry microsecond-precision sort values; a malformed cursor is `400`. | repository + cursor helpers |
| BR-16 | `?email=` is an exact, case-insensitive (`CITEXT`) match among live rows; `role`/`status` are enum-validated; unknown query parameters are rejected. | DTO + repository |
| BR-17 | History rows are append-only and never purged; there is no update or delete function. | repo surface; retention table |
| BR-18 | Access tokens issued before a suspension remain valid until they expire (<= 15 min); accepted (ADR 0002). Care additionally blocks suspended doctors locally. | documented residual |

Known limitation (BR-14): the worker purges a refresh-token row 30 days after its own `expires_at`, so the **earliest
retained** token of a family can be later than the original login for a family kept alive for roughly two months
or more; `createdAt` then reports the earliest retained token. Not blocking; see Contract changes (C-2, wording).

## 6. Cross-service behavior
None on these routes: no outbound calls, no service token. Indirectly, `UsersService.applyStatusChange` is the
code Epic B's `PATCH /internal/users/{id}/status` (Cases 1 and 3) will reuse with `caller.kind = "service"`, its
own transition table, and the same lock order; that spec decides the doctor/patient target rules for the service
caller. Care's local doctor blocking is unaffected because admins cannot change doctor status here (ADR 0012).

## 7. Error codes

| Code | HTTP | When |
|---|---|---|
| `ValidationFailed` | 400 | non-numeric/`< 1` id; bad `role`/`status`/`email`/`limit`/`cursor`; unknown query or body field; `status` not `active`/`suspended`; empty, blank or > 500-char `reason` |
| `Unauthorized` | 401 | missing/invalid bearer token; the acting admin's account no longer exists |
| `TokenExpired` | 401 | access token expired |
| `Forbidden` | 403 | caller is not an admin; or the status target is self, another admin, or a doctor |
| `AccountSuspended` | 403 | the acting admin is suspended (claim or live row) |
| `NotFound` | 404 | target user absent or soft-deleted |
| `InvalidStatusTransition` | 409 | the pair is not in `ADMIN_TRANSITIONS` (and the status differs) |
| `InternalError` | 500 | unhandled (including a transaction rolled back by an unexpected `0`-row update) |

No new codes. `Conflict`, `IdempotencyConflict`, `RateLimited` are not produced by these routes.

## 8. Security & privacy

### 8.1 RBAC summary
| Route | Roles | Ownership | Account state |
|---|---|---|---|
| `GET /api/users` | admin | none | active |
| `GET /api/users/{id}` | admin | none | active |
| `PATCH /api/users/{id}/status` | admin | none; target patient only, not self | active (claim + live row) |
| `GET /api/users/{id}/sessions` | admin | none | active |
| `DELETE /api/users/{id}/sessions` | admin | none | active (claim + live row) |

### 8.2 Audit events (log lines; ids only)
`user_status_changed` `{ actorUserId, userId, from, to, revokedSessions }`, `admin_sessions_revoked`
`{ actorUserId, userId, revokedSessions }`, `status_change_refused` `{ actorUserId, userId, reason: "self" | "admin" |
"doctor" | "transition" }`, `access_denied` (from `authorize`). The durable audit record for status is
`user_status_changes` (PRD 7.12): actor, reason, request id, timestamp.
Session revocation has no history table in MVP; its audit is the log line plus `refresh_tokens.revoked_reason =
'admin_revoked'` and `revoked_at`.

### 8.3 Never logged or returned
`reason` (free text, may contain PII), the `email` filter value, any returned `email`/`phone`/`fullName`, cursors,
refresh-token values/hashes, `deviceInfo`. The request logger logs no query strings, headers, URLs, or bodies
(verified in `src/lib/logger/request-logger.ts`; resolves brainstorm Q2), so the `email` filter cannot leak through
request logs. Superseded by ADR 0021: `reason` is not added to the redaction keys; it is simply never logged. Error messages for the 403 cases carry
no user data.

### 8.4 Rate limits
None specified in CLAUDE.md -> Security rules for these routes; they require an admin bearer token and are low
volume. No limiter is added (a deliberate omission, not a gap). Revisit if admin tokens ever become broadly issued.

### 8.5 Files
None.

## 9. Performance
| Path | Queries | Index | Budget |
|---|---|---|---|
| `GET /api/users` | 1 (`limit + 1`) | section 2.2 indexes / `uq_users_email`; `EXPLAIN` the unfiltered, `role`, `status`, `email` and page-2 forms | p95 < 100 ms (read) |
| `GET /api/users/{id}` | 1 | primary key | p95 < 100 ms |
| `PATCH .../status` | actor read, lock, update, history insert, revoke update, commit | pk; `idx_refresh_tokens_user_id_created_at` for the revoke | other writes p95 < 200 ms |
| `GET .../sessions` | user existence read + 1 list query | `idx_refresh_tokens_user_id_live`, `idx_refresh_tokens_family_id_created_at` | p95 < 100 ms |
| `DELETE .../sessions` | actor read, lock, 1 update | `idx_refresh_tokens_user_id_created_at` | p95 < 200 ms |
| **`POST /api/auth/refresh`** (changed) | + 1 pk `FOR SHARE` read | pk | **p95 < 50 ms must still hold**; re-measure with the concurrency suite |

No N+1 (the family `LATERAL` is one statement). Lists always cursor-paginated, `limit <= 100`.

## 10. Test plan outline

### 10.1 Unit (`tests/unit/app/users/`, collaborators mocked)
- `status-transitions`: `ADMIN_TRANSITIONS` exactly two pairs; every other pair absent.
- `UsersService.applyStatusChange` ordering: lock before any write; target rules before the transition check; no-op
  writes nothing; history insert and revoke are called on the same `trx`; rollback on failure of any step.
- `UsersService.revokeSessions` / D-5 live-actor re-read (absent -> `Unauthorized`, suspended -> `AccountSuspended`).
- Cursor helpers (`encodeKeyCursor`/`decodeKeyCursor`): round-trip, invalid UUID/timestamp/oversized -> `ValidationFailed`.
- DTOs: `AdminStatusChangeDto` rejects `pending`, `rejected`, blank reason, extra field; `ListUsersQueryDto` rejects
  unknown params; `UserIdParamDto` rejects `0`, `-1`, `abc`.
- `SessionService.rotate` step order (user `FOR SHARE` before token `FOR UPDATE`) with mocked repos.
- Response DTOs contain no secret fields.

### 10.2 Integration (`tests/integration/users/*.test.ts`, real Postgres + Redis; truncate per suite)
Per route: success shape against the contract, and each error code of section 7.
- should list users newest first and reach page 2 on the default sort without duplicates or gaps, including rows
  that share a millisecond (BR-15)
- should filter by role, by status, and by email case-insensitively, and never list a soft-deleted user (BR-3, BR-16)
- should return 404 for an absent or soft-deleted user on get, status, sessions, and revoke (BR-3)
- should suspend a patient, write exactly one history row with `actor_user_id` = caller and `actor_service` null, and
  revoke all families (`status_changed`) in one transaction; the next refresh returns `401 RefreshTokenInvalid` and login
  is refused (BR-7, BR-8)
- should reinstate a suspended patient, write one history row, and allow login again (BR-9)
- should return 200 with no history row and no `updated_at` change when the status is unchanged (BR-6)
- should return 403 Forbidden and write nothing when the target is self, another admin, or a doctor, including when
  the requested status equals the current one (BR-4)
- should return 409 InvalidStatusTransition for a `pending` or `rejected` patient (BR-5) and 400 for `pending`/`rejected`
  requested statuses
- should roll back the status update when the history insert or the revoke fails (inject a failing constraint) (BR-7)
- should list only live families, with correct `createdAt`/`lastUsedAt`/`expiresAt`, and never a token or hash
  anywhere in the body (BR-14); should page sessions with the family-id tiebreaker
- should revoke all sessions with `admin_revoked` and return 204 twice (idempotent) (BR-13); the target's refresh fails
- should refuse a suspended admin's token (claim) and a token whose admin was suspended since issue (live row) on the
  mutating routes (BR-1, BR-2)
- **Contract conformance:** statuses, error codes and body shapes of all five operations against
  `contracts/openapi.yaml`.

### 10.3 RBAC (per route, all five)
patient token -> `403 Forbidden`; doctor token -> `403 Forbidden`; no token -> `401`; user token of a suspended admin
-> `403 AccountSuspended`; admin -> allowed. The status route additionally: admin vs doctor/admin/self target -> `403`.

### 10.4 Concurrency and lock order (mandatory, ADR 0019 / ADR 0020)
Forced interleavings use a test-held transaction and `pg_stat_activity`/`pg_locks` to prove a statement is blocked at
the lock boundary, then release it; plus a repeated stress form. Each asserts the invariant "no live refresh token
remains for the revoked scope" and that no request returns `500` or a deadlock (`40P01`).
- should leave no refreshable token when a suspension and a refresh run concurrently (suspend-vs-refresh): hold
  `SELECT ... FOR UPDATE` on the user in a test transaction, start `POST /auth/refresh`, assert it is waiting, then
  run the status change steps and commit; the refresh must end `403 AccountSuspended` (it was waiting on the lock and re-reads the user) with zero live tokens. Stress:
  N iterations of `Promise.all([suspend, refresh])` with random start jitter.
- should leave no refreshable successor after an admin session revoke races a refresh.
- should leave none after logout races a refresh of the same family; after reset-password races a refresh; after
  change-password races a refresh of another family (ADR 0020 follow-up).
- should leave no live successor when reuse-detection revocation races a refresh of the successor.
- should let two refreshes of different families of one user proceed concurrently (`FOR SHARE` coexistence), and
  serialise two refreshes of the same token with exactly one `rotated` and the other `grace`.
- should not deadlock when suspend, revoke, logout and refresh for the same user all run at once.

### 10.5 CLAUDE.md -> Testing policy scenarios covered here
RBAC per route; admin status route refuses a doctor target; suspension revokes all sessions and the following refresh
fails; pagination page 2 on the default sort; no secret in any body; `rejected` login/refresh unaffected by this
module (auth suites keep passing after the `rotate` change).

### 10.6 One line per business rule
BR-1 RBAC suite; BR-2 stale-claim test; BR-3 soft-delete cases; BR-4 target refusals; BR-5 transition table + 409
test; BR-6 no-op; BR-7 history row + rollback; BR-8 suspend then refresh; BR-9 reinstate then login; BR-10 unit step
order + 10.4; BR-11/BR-12 10.4; BR-13 revoke idempotence; BR-14 session shape; BR-15 page 2; BR-16 filters; BR-17 repo
exposes no update/delete (unit); BR-18 asserted in docs only (an access token issued pre-suspension still verifies).

## 11. Out of scope
- `PATCH /internal/users/{id}/status`, `GET /internal/users` (Epic B); the service-caller transition table and its
  target rules.
- Any doctor status change on the public API (ADR 0012); doctor reinstatement (no API path in MVP).
- Reading status history over the API; session detail, geo/IP, or revoking one family by id.
- Admin-created accounts, provisioning CLI, admin MFA (ADR 0010); soft delete endpoint; email change; PII anonymization
  (ADR 0011).
- A rate limiter for admin routes; idempotency middleware on these routes.
- A native outbox/email notice to the suspended user (not in the PRD for MVP).

## 12. Contract changes required (`contracts/openapi.yaml` — do not edit from this spec author)
None blocks the build; all five operations, schemas and error codes already match this spec.
- **C-1 (additive, recommended):** add the `Cache-Control: no-store` response header (`CacheControlNoStore`) to the
  `200` responses of `listUsers`, `getUserById`, `listUserSessions` and `updateUserStatus`, because they carry PII.
  Implemented regardless; the header is additive and breaks no client.
- **C-2 (wording, recommended):** in `Session.createdAt`, state "earliest retained token of the family (equals the
  login time while that token has not been purged)"; in `listUserSessions`, the keyset tiebreaker stays
  `family_id` ascending (no change required to behavior).
- `operationId`s and `x-error-codes` already include `AccountSuspended`, `Forbidden`, `NotFound`,
  `InvalidStatusTransition` where this spec returns them.

## 13. Build notes
- Recommended task order: migrations -> status-transitions + enums/errors/types -> repos (`user.repo`,
  `refresh-token.repo`, `user-status-change.repo`) -> `AccountService`/`SessionService` additions and the lock-order
  rewrite of `rotate`/`logout`/reuse-revoke (**with their concurrency tests in the same task**) -> `UsersService` ->
  DTOs, policy, controller, routes, mount -> integration/RBAC/contract tests -> manual QA.
- Keep the auth integration suites green after the `rotate` change before layering `users` on top.
- `docs/service-card.md` **is affected** (new public endpoints in the owned-endpoints list and the status-history
  table in owned data); update in `/update-docs users`. Also in `/update-docs`: ADR 0020 note on `FOR SHARE` (D-6),
  `architecture/api.md` / `data-model.md` reconciliation, and the `docs/users/tasks.md` task list.

## 14. As-built notes (2026-10-07)
- **Refresh after suspension is `401 RefreshTokenInvalid`, not `403`.** Suspension revokes every family in the same
  transaction, so a later refresh finds a revoked, non-rotated token and `judgeRevoked` returns `invalid`. `403
  AccountSuspended` is returned only when the status changes while a refresh is waiting on the user lock (it
  re-reads the user under `FOR SHARE`, finds `suspended`, revokes the family). Both codes are allowed by the
  contract; BR-8 and section 10.2 were reworded in v1.0.1 (manual QA N-1, review 2026-10-07 15:00).
- **Contract notes C-1 and C-2 are applied** in `contracts/openapi.yaml` (`Cache-Control: no-store` on the four `200`
  responses; `Session.createdAt` wording). No other contract drift was found against the as-built routes.
- **Logging:** `reason` is deliberately not a logger redaction key (section 8.3 said to add it). Free-text reasons
  are never logged; new log lines use `cause` for enum causes. See
  [ADR 0021](../adr/0021-reason-field-not-redacted-in-logs.md).
- **Index `idx_refresh_tokens_user_id_live`** is `(user_id) WHERE revoked_at IS NULL` as specified in section 2.2.

## 15. Open questions
None. Resolved here: brainstorm Q1 (D-1), Q2 (8.3), Q3 (3.7).
