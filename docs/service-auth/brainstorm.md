---
title: service-auth and internal-users — Brainstorm
owner: identity-team
service: identity-service
module: service-auth
status: draft
diataxis: explanation
last_verified: 2026-10-07
tags: [brainstorm, service-auth, internal-users, client-credentials, internal-listener]
related: [system-design, service-auth, users-spec, adr-0012-doctor-status-only-via-care]
---

# service-auth and internal-users — Brainstorm

Decisions below were agreed with the user on 2026-10-07. The contract already defines every operation
(`/internal/auth/token`, `/internal/users`, `/internal/users/{id}/status`, `/internal/health/*`), so this
iteration is mostly implementation, not contract design.

## Problem & purpose

Care authenticates against Identity without touching its database. Today the internal listener has no
service-to-service auth, so Care cannot hydrate profiles (Case 2), apply verification outcomes (Case 1), or
suspend accounts and revoke sessions (Case 3). Identity is the provider in all three.

## Actors

- `care-service` (service client): the only MVP caller.
- Ops: provisions the client row and rotates its secret.
- Admins/users: never call `/internal/*`; a user token there is `401 ServiceTokenRequired`.

## In scope (this iteration)

Cases 1-3 only, delivered as **two modules, `service-auth` first**:

1. `service-auth`: `service_clients` table, `POST /internal/auth/token`, `service-guard`, internal listener
   wiring, `/internal/health/live|ready`, per-client rate limit (60/min), runbook provisioning section.
2. `internal-users`: `GET /internal/users?ids=` and `PATCH /internal/users/:id/status`, reusing the `users`
   module's shared status-change service method.

## Out of scope

- Case 4 (doctor reinstatement `suspended` to `active`): needs `/system-design` and an ADR 0012 amendment.
- Case 5 (`GET /internal/users/contacts`, scope `users:contact:read`): same, tracked in the hub `TODO.md`.
- A provisioning CLI, secret-rotation endpoints, static API keys, `doctors:read` clients.

## Key entities & relationships

`service_clients` (`client_id`, `client_secret_hash` argon2id, `allowed_scopes`, `allowed_audiences`,
`is_active` flag, soft delete) is defined in `docs/architecture/data-model.md`. `user_status_changes.actor_service`
holds the calling client's `client_id` (logical reference, no FK).

## Primary flows / endpoints (roles + ownership)

| Route | Caller | Auth | Notes |
|---|---|---|---|
| `POST /internal/auth/token` | service | client credentials | no token needed; 60/min per client; unknown client, wrong secret, disabled client all `401 InvalidCredentials`; dummy argon2 verify for unknown clients |
| `GET /internal/users?ids=` | service | scope `users:read` | at most 100 ids, unknown ids omitted, no email or phone |
| `PATCH /internal/users/:id/status` | service | scope `users:status:write` | idempotent; Care transitions only |
| `GET /internal/health/live\|ready` | infra | none | readiness fatal on Postgres only (ADR 0014) |

## Business rules & state transitions

- Care transitions: `pending` to `active` or `rejected`; `rejected` to `pending`; `active` to `suspended`.
  Same status again is a 200 no-op with no history row. Any other pair is `409 InvalidStatusTransition`.
- Entering `suspended` or `rejected` revokes all refresh-token families, with the status change and history
  row, in one transaction (Case 3 and domain rule 4).
- Suspension of a non-`active` target is `409 InvalidStatusTransition` (signals drift; Care alerts).
- **`actorUserId` is recorded only** (decision): stored in `actor_user_id`, with `actor_service` from the token
  `sub`. No existence or role check, so Case 3 retries can never be blocked by a deleted actor.
- Never trust `X-User-Id`, `X-Role`, or similar headers; the verified service token is the only principal.

## Cross-service touchpoints (case, direction, failure policy)

All three cases: Care calls Identity. Internal endpoints make no outbound calls, p95 under 50 ms. Case 1
`409` is non-retryable; Case 3 is retried by Care until success; `X-Request-Id` is adopted and logged.

## Privacy & audit

Batch lookup returns no email or phone. Service tokens, client secrets, and hashes are never logged. Every
status change writes `user_status_changes` with `actor_service` and `request_id`.

## Constraints & guideline notes

- Client provisioning (decision): **ops runbook plus a documented one-off script that prints the INSERT**; no
  CLI code, mirroring the manual-admin approach (ADR 0010). Local dev gets a synthetic `care-service` seed.
- Service token TTL 300 s, no refresh token, EdDSA via `jose`, `aud` must include `vcare-identity` on guarded
  routes. Argon2 verification runs behind the existing hash semaphore.
- Redis down: the per-client limiter falls back to the in-process limiter (ADR 0008).

## Contract changes expected

None expected. Verify the existing operations against the spec during `/construct-spec`; if any gap appears,
change `contracts/openapi.yaml` first and tell Care, since `/internal/*` changes are breaking for it.

## Open questions

Resolved 2026-10-07:

1. **Disabled marker: `is_active` (corrected 2026-10-07).** `service_clients.is_active BOOLEAN NOT NULL` already
   exists in `data-model.md`, so no `disabled_at` column is added. Ops sets `is_active = false` to lock out a client
   without deleting its row; disabled clients get `401 InvalidCredentials`.
2. **IP rate limit on failed token requests: yes.** In addition to 60/min per `client_id`, limit by IP so a
   caller probing unknown `client_id`s cannot bypass the per-client limiter. The spec sets the number and the
   Redis-down fallback (ADR 0008).
3. **`actorUserId` and `409` handling: nothing to change in Identity.** `actorUserId` is the numeric Identity
   user id of the acting admin, recorded as data only. Care's ADR 0004 already treats
   `409 InvalidStatusTransition` as non-retryable (outbox row `failed`, alert) and retries everything else, which
   matches the contract. Note: Care ADR 0012 already plans Case 4 calls, so Case 4 is the next provider change
   to design after this iteration.

## Success criteria

- Care can obtain a token, batch-hydrate profiles, and apply Case 1 and Case 3 status changes end to end.
- User token on any guarded `/internal/*` route returns `401 ServiceTokenRequired`; missing scope returns
  `403 InsufficientScope`.
- Suspension revokes all sessions and a following refresh fails; repeats are idempotent.
- p95 under 50 ms for `/internal/users` with 100 ids; integration and RBAC tests green.
