---
title: "ADR 0025: The internal status route accepts doctor targets only"
owner: identity-team
service: identity-service
status: accepted
date: 2026-10-08
diataxis: explanation
last_verified: 2026-10-08
tags: [adr, decision, account-status, cross-service, authorization]
related: [adr-0012-doctor-status-only-via-care, adr-0023-internal-status-accepts-suspended-to-active, internal-users-spec, service-auth]
---

# ADR 0025 — The internal status route accepts doctor targets only

- **Status:** Accepted • **Date:** 2026-10-08 • **Deciders:** identity-team
- **Amends:** [ADR 0023](./0023-internal-status-accepts-suspended-to-active.md) — only its bullet "The route is not
  role-gated" and the matching Consequences cost. Everything else in ADR 0023 stands.

## Context

ADR 0023 left `PATCH /internal/users/{id}/status` without a target-role check and accepted that a holder of
`users:status:write` could change any live user, including an admin. Care only ever sends doctor ids (Cases 1, 3, 4),
and Identity already loads the target row under lock, so the check costs nothing and removes a privilege no caller needs.

## Decision

- After the existence check (absent or soft-deleted -> `404 NotFound`), a target whose `role` is not `doctor` is
  refused with `403 Forbidden`, non-retryable, with no write. The same code the public admin route returns for a doctor
  target, mirrored: patients are changed only by admins on the public route, doctors only by Care on the internal one.
- The transition table (ADR 0023) is unchanged.
- `actorUserId` stays record-only data: it never authorizes anything (unknown ids are stored as NULL and logged).

## Consequences

- Good: a leaked or misused service client can no longer change an admin's or a patient's status.
- Good: the two status routes now partition the user population cleanly (public = patients, internal = doctors).
- Cost: contract change to `internalUpdateUserStatus` (new `403 Forbidden`). Non-breaking for Care, which only sends
  doctor ids; any other caller sees a new refusal.
- Cost: a future internal client that must change patient status needs a new ADR and scope.

## Alternatives considered

- **Keep ADR 0023 as written (accepted residual risk)** — rejected: no legitimate caller needs the breadth.
- **Per-scope split (`users:status:doctor:write`)** — rejected for now: one client, one scope; the role check is simpler.
