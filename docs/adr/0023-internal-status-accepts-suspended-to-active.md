---
title: "ADR 0023: The internal status route accepts suspended -> active (Case 4, doctor reinstatement)"
owner: identity-team
service: identity-service
status: accepted
date: 2026-10-08
diataxis: explanation
last_verified: 2026-10-08
tags: [adr, decision, account-status, cross-service, reinstatement]
related: [adr-0012-doctor-status-only-via-care, api, service-auth, hub-adr-0009]
---

# ADR 0023 — The internal status route accepts `suspended -> active` (Case 4)

- **Status:** Accepted • **Date:** 2026-10-08 • **Deciders:** identity-team, with platform-team (hub ADR 0009)
- **Amends:** [ADR 0012](./0012-doctor-status-only-via-care.md) — only its last Decision bullet ("Reinstating a suspended
  doctor has no API path in MVP"). Everything else in ADR 0012 stands.

## Context

ADR 0012 made Care the only initiator of doctor account-status changes but left reinstatement without a path: the
public admin route refuses doctor targets and the internal route refused `suspended -> active`, so reinstating a
doctor meant a manual two-database ops procedure. Hub [ADR 0009](../../../vcare-hub/adr/0009-doctor-reinstatement-via-care.md)
(Case 4) decided that Care initiates reinstatement and that Identity, as provider, ships the change first.

## Decision

- `PATCH /internal/users/{id}/status` with `{ status: "active" }` accepts `suspended -> active`. The internal
  transition table is now: `pending -> active | rejected`, `rejected -> pending`, `active -> suspended`,
  `suspended -> active`. Every other pair stays `409 InvalidStatusTransition` (non-retryable for the caller).
- **Idempotent:** a target that is already `active` returns 200 with no new `user_status_changes` row, so Care's
  retrier can call blindly.
- Entering `active` writes the `user_status_changes` row (`actor_service` = token `sub`, `actor_user_id` = the body
  value recorded as data) in the same transaction as the update. It touches **no** refresh token: families revoked at
  suspension stay revoked, and the doctor signs in again.
- The route is not role-gated, like every internal transition: the verified service token with scope
  `users:status:write` is the authorization, and Care is the only holder in MVP and calls it for doctors only.
- **Unchanged:** `PATCH /api/users/{id}/status` still returns `403 Forbidden` for a doctor target, and still allows
  `suspended -> active` for patients (admin). CLAUDE.md -> Domain rules (status transitions) and "Out of scope" are
  updated to match.

## Consequences

- Good: one audited path for doctor reinstatement, still Care-only initiation; no manual cross-database step.
- Good: no new endpoint, scope, table or error code; the change is one row in a transition table.
- Cost: a service client holding `users:status:write` can lift a suspension on any account through the internal
  route. The client set is ops-provisioned and `care-service` already holds the scope for suspending, so the trust
  boundary is unchanged.

## Alternatives considered

- **A separate `/internal/users/{id}/reinstate` route** — rejected: duplicates the status contract for one pair.
- **Role-gate the internal transition to doctors** — rejected for now: no other internal transition checks the role,
  and Care already decides who may be reinstated.
- **Keep ops-only** — rejected by hub ADR 0009: drift risk between the two databases.
