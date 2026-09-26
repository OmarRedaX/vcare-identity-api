---
title: users — Brainstorm
owner: identity-team
service: identity-service
module: users
status: draft
diataxis: explanation
last_verified: 2026-09-17
tags: [brainstorm, users, admin, account-status, sessions, audit]
related: [system-design, design-baseline, auth-brainstorm, auth-tokens, data-model, api, adr-0004-rejected-doctors-can-sign-in, adr-0010-manual-admin-provisioning-role-policies, adr-0012-doctor-status-only-via-care]
---

# users — Brainstorm

Epic A ("public surface") = [`auth`](../auth/brainstorm.md) then **`users`** (this brief). Built **after** `auth`.

## Problem & purpose
Admins need to find accounts, act on abusive or compromised **patient** accounts, and kill sessions. `users`
delivers admin account management on the public API: list/search users, view one, suspend or reinstate a patient,
and view or revoke a user's sessions — with every status change recorded in an append-only history. It also
introduces the **status-transition rules and history table** that Epic B's internal status route will reuse.

## Actors
- **Admin** (user token, `role=admin`, `status=active`) — the only caller of every route here.
- **Patient** — the only valid target of a status change.
- **Doctor, other admins, self** — refused as status-change targets (`403 Forbidden`).

## In scope (this iteration)
- 5 operations: `GET /api/users`, `GET /api/users/{id}`, `PATCH /api/users/{id}/status`,
  `GET /api/users/{id}/sessions`, `DELETE /api/users/{id}/sessions`.
- Migration: `user_status_changes` (with `chk_user_status_changes_actor`, `chk_user_status_changes_differs`).
- Status-transition logic (domain rule 3) in a form Epic B's internal route can call through the service
  (never through the repository).
- Session read model: a session = a live refresh-token family, keyset-paginated.
- Policies with explicit `roles: ["admin"]`, `owner: "none"`, and the `active` account-state requirement.

## Out of scope
- `PATCH /internal/users/{id}/status`, `GET /internal/users` → Epic B (they reuse this module's service).
- Doctor status changes of any kind (ADR 0012 — Care only); doctor reinstatement (no API path in MVP; hub ADR 0009
  proposes one via Care — Epic B decision).
- Account creation by admins, admin provisioning CLI (ADR 0010); account soft delete (no endpoint).
- Reading a user's status history over the API (history is written, not exposed, in MVP).

## Key entities & relationships
- `users` (from `auth`) 1—* `user_status_changes` as subject; admin `users` 0..1—* `user_status_changes` as actor.
- `refresh_tokens` (from `auth`) grouped by `family_id` for the session view and revocation.

## Primary flows / endpoints (with roles + ownership)
| Operation | Roles | Ownership | Notes |
|---|---|---|---|
| `GET /api/users` | admin | none | keyset on `(created_at DESC, id DESC)`; whitelisted filters `role`, `status`, `email` (exact, case-insensitive); soft-deleted never listed |
| `GET /api/users/{id}` | admin | none | `404` when absent or soft-deleted |
| `PATCH /api/users/{id}/status` | admin | none; target must be a patient, not self | `active ↔ suspended` only; same status → 200 no history; entering `suspended` revokes all families (`status_changed`); update + revocation + history row (`actor_user_id` = caller, `actor_service` null, `request_id`) in one tx |
| `GET /api/users/{id}/sessions` | admin | none | live families only; keyset on `(created_at DESC, family_id)`; never token values or hashes |
| `DELETE /api/users/{id}/sessions` | admin | none | revoke every family (`admin_revoked`); idempotent `204` |

The caller's account state must be `active` (a suspended admin → `403 AccountSuspended`).

## Business rules & state transitions
- Admin-allowed transitions: `active → suspended`, `suspended → active` (patients only). Every other pair →
  `409 InvalidStatusTransition`. Same status → 200 no-op, no history row.
- Target is self, another admin, or a doctor → `403 Forbidden` (checked before the transition).
- Entering `suspended` revokes all refresh tokens in the same transaction (domain rule 4); the residual ≤ 15-min access
  window is accepted (ADR 0002).
- History is append-only and never purged.

## Cross-service touchpoints (case, direction, failure policy)
None on this module's routes. Indirect: Epic B's `PATCH /internal/users/{id}/status` (Cases 1 and 3) will reuse the
transition + revocation + history service built here, with `actor_service` set and a different allowed-transition set.

## Privacy & audit
- Admin responses return the `User` schema (email and phone are visible to admins by contract); never password hashes
  or token hashes.
- The `email` filter value is PII — never logged; query strings with it must be redacted from request logs.
- `user_status_changes` satisfies PRD §7.12 audit for account status: actor, reason, request id, timestamp.

## Constraints & guideline notes
- Cross-module access to `refresh_tokens` goes through `auth`'s service, never its repository.
- Indexes already planned per query (`idx_users_*_created_at_id`, `idx_refresh_tokens_user_id_live`,
  `idx_user_status_changes_*`); `EXPLAIN` the list query.
- Mandatory tests: RBAC per route (patient/doctor denied, admin allowed), admin refused for doctor/admin/self targets,
  suspension revokes all sessions and a subsequent refresh fails, pagination page 2 reachable on the default sort,
  every transition rule has a named test.

## Contract changes expected
None planned — the users operations (including the doctor-target refusal) were applied on 2026-09-16.

## Open questions
1. **Where the shared status-transition code lives** so Epic B reuses it without a cross-module repository import:
   `users` service method with a caller-kind parameter (admin vs service) and per-caller transition tables, or a small
   `account-status` service inside `users`. Spec decides; recommendation: one `users` service method, two transition tables.
2. **`email` filter logging:** confirm the request logger drops query strings (or redacts `email`) — foundation logs
   `route`, but verify during spec.
3. **Sessions page cursor** on `(created_at, family_id)` where `family_id` is a UUID — confirm the shared cursor helper
   supports a non-numeric tiebreaker, or extend it.

## Success criteria
- All 5 operations conform to the contract in integration tests against real Postgres and Redis.
- An admin suspends a patient → the patient's next refresh fails with `403 AccountSuspended`; reinstating restores
  login. Doctor/admin/self targets are refused with no history row.
- History rows exist for every real change and none for no-ops.
- Typecheck, lint, tests green; manual QA passes; review clean; docs reconciled.
