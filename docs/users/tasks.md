---
title: users — Tasks
owner: identity-team
service: identity-service
module: users
status: draft
diataxis: reference
last_verified: 2026-09-17
tags: [tasks, users, admin, account-status, sessions]
related: [users-brainstorm, auth-tasks]
---

# users — Tasks

Source: [spec.md](./spec.md) (not yet written — `/construct-spec users`). Each task is tagged with its step from
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
_Written by `flow-developer` from `spec.md`._
- [ ] (service) status change locks the `users` row `FOR UPDATE` first, then updates status, writes history and revokes all families; change `SessionService.rotate` in the same unit to the same lock order (user `FOR SHARE`, then token `FOR UPDATE`) and add a suspend-versus-refresh concurrency test (ADR 0019, review 2026-10-04)
