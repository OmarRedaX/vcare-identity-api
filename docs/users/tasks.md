---
title: users — Tasks
owner: identity-team
service: identity-service
module: users
status: done
diataxis: reference
last_verified: 2026-10-07
tags: [tasks, users, admin, account-status, sessions]
related: [users-brainstorm, users-spec, auth-tasks]
---

# users — Tasks

Source: [spec.md](./spec.md) (status ready). Each task is tagged with its step from
CLAUDE.md → "Build order for a new module". Statuses are kept live while building.

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
_Written by `flow-developer` from `spec.md`; contract operations, C-1 and C-2 already applied in `contracts/openapi.yaml`._
- [x] (contract) five `users` operations, error codes, C-1 `Cache-Control: no-store`, C-2 `Session.createdAt` wording (already in `contracts/openapi.yaml`)
- [x] (migration) `20261007000100_create_user_status_changes` (table, named constraints, two commented indexes)
- [x] (migration) `20261007000200_add_users_list_and_session_indexes` (five additive indexes, commented, real down)
- [x] (enums-errors-types) `enums.ts`, `errors.ts`, `types.ts`, `status-transitions.ts` (`ADMIN_TRANSITIONS`)
- [x] (enums-errors-types) auth `types.ts` additions: `UserListRow`, `UserListItem`, `LiveFamilyRow`, `LiveFamily`, cursors
- [x] (entity) `UserStatusChange`
- [x] (request-dto) `UserIdParamDto`, `ListUsersQueryDto`, `ListSessionsQueryDto`, `AdminStatusChangeDto`
- [x] (response-dto) `SessionResponseDto`, `StatusChangeResponseDto` (`UserResponseDto` reused)
- [x] (repository) `user.repo`: `listLive`, `findLiveByIdForShare`, `updateStatus`; `refresh-token.repo`: `listLiveFamilies`; `user-status-change.repo`: `insertStatusChange`
- [x] (repository) `lib/http/pagination`: `encodeKeyCursor` / `decodeKeyCursor` / `buildKeyPage`
- [x] (service) `AccountService`: `listLive`, `lockLiveById`, `updateStatus`
- [x] (service) `SessionService`: `listLiveFamilies`; `rotate` user `FOR SHARE` then token `FOR UPDATE` with re-checks; `logout` and reuse-detection revoke user-first (ADR 0019 / 0020); update existing session unit tests
- [x] (service) status change locks the `users` row `FOR UPDATE` first, then updates status, writes history and revokes all families; change `SessionService.rotate` in the same unit to the same lock order (user `FOR SHARE`, then token `FOR UPDATE`) and add a suspend-versus-refresh concurrency test (ADR 0019, review 2026-10-04) — code part: `UsersService` (`getUser`, `listUsers`, `listSessions`, `revokeSessions`, `applyStatusChange`) + container registration; the suspend-versus-refresh concurrency test remains a `(tests)` task for `/write-tests`
- [x] (policies) `policies.ts` — `adminUsersPolicy`
- [x] (controller) `UsersController` + container registration
- [x] (routes) `routes.ts` — guard, authorize, no-store on the four 200s, handler
- [x] (mount) `src/routes.ts` at `/users`
- [x] (logging) `reason` is deliberately not a redaction key (ADR 0021: about a dozen existing log lines use `reason` as a safe enum cause). New logs use `cause`; `reason` free text is never logged
- [x] (tests) unit (status transitions, UsersService, DTOs, controller, key cursors, SessionService lock order), integration (RBAC, list, get, status, sessions, rollback, privacy) and the spec 10.4 concurrency suite are written and green (`npm test`, `npm run test:integration`). The low-severity `UserIdParamDto` bug (`/api/users/1e3` resolved id 1000) is fixed: the id converts only when the segment matches `/^[1-9][0-9]*$/`, and its test is now a normal test.
- [x] (manual-qa) ← /manual-qa
- [x] (docs) service-card, INDEX, ADR 0020 `FOR SHARE` note, api.md / data-model.md, spec BR-8 / 10.2 rewording (v1.0.1) ← /update-docs (2026-10-07)
