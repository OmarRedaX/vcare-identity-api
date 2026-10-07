---
title: "ADR 0020: Refresh rotation versus family and user revocation — shared lock order"
owner: identity-team
service: identity-service
status: accepted
date: 2026-10-05
diataxis: explanation
last_verified: 2026-10-07
tags: [adr, decision, refresh-token, revocation, concurrency]
related: [auth-spec, users-tasks, adr-0002-asymmetric-jwt-rotating-refresh, adr-0005-refresh-reuse-grace-window, adr-0019-refresh-versus-suspension-lock-order]
---

# ADR 0020 — Refresh rotation versus revocation: shared lock order

- **Status:** Accepted • **Date:** 2026-10-05 • **Deciders:** identity-team

## Context

`SessionService.rotate` locks the presented refresh-token row (`FOR UPDATE`), reads the user without a lock,
inserts a successor token, and marks the presented token rotated. Password reset (`revokeAllForUser`), password
change (`revokeAllExceptFamily`), and logout (`revokeFamily`) update live token rows by user or family in
`READ COMMITTED`. If a revocation starts while rotation holds the presented token lock, it waits, then re-checks
that row without necessarily seeing the successor inserted by rotation. One refreshable successor can therefore
survive a reset, logout, or change-password revocation. This is the family/user-wide sibling of the suspension
residual recorded in [ADR 0019](./0019-refresh-versus-suspension-lock-order.md).

## Decision

Accept this residual for now; do **not** change `rotate` in the auth module alone. Fix the single lock order once,
with every revocation path in view, during the `users` / `internal-users` work. In rotate, reset,
change-password, logout, suspension, and admin session revocation, lock the user row `FOR UPDATE` first and then
the relevant token rows. After acquiring the user lock, rotation must re-check the presented token's state and
re-read the user before issuing the successor. The implementation and concurrency tests belong to that joint
change. ADR 0019 remains the record of the suspension-specific residual.
For the joint implementation, this uniform `FOR UPDATE` order refines ADR 0019's suspension-only lock plan.

## Consequences

- A refresh that lands within milliseconds of revocation on the same family can leave one live successor on a
  family that should be dead. It can mint access tokens of up to 15 minutes each (ADR 0002) until that successor
  is used or expires; the access-token exposure can therefore extend beyond the one-token residual described in
  ADR 0002. Reuse detection (ADR 0005) does not help: the old token was legitimately rotated.
- Refresh is a hot path with a p95 < 50 ms budget. The natural status-change order is user -> tokens. Adding a
  token -> user lock to rotation now could deadlock against that order; the shared order must be implemented and
  measured with all callers together. No auth behaviour changes under this decision.

## Implementation note (2026-10-07)

The joint implementation shipped with the `users` module ([users/spec.md](../users/spec.md) D-6, section 3.8).
`rotate` locks the user row `FOR SHARE` (`findLiveByIdForShare`) and then the presented token `FOR UPDATE`;
the revokers (status change, admin session revoke, logout, reuse-detection revoke, reset and change-password)
lock the user `FOR UPDATE` (or take the equivalent row write lock) first. `FOR SHARE` conflicts with every
`FOR UPDATE`/`UPDATE` on the user, so rotation and revocation of one user are fully serialised, while concurrent
refreshes of different devices of the same user still run in parallel. This is the refinement of the uniform
`FOR UPDATE` wording above, consistent with ADR 0019. The residual described in Context is closed for these paths;
the concurrency suite is `tests/integration/users/concurrency.test.ts`.

## Follow-up

With the `users` / `internal-users` lock-order change, add forced concurrent reset/refresh, logout/refresh,
and change-password/refresh tests that hold the competing transactions at the lock boundary and assert that no
refreshable successor survives revocation.
