---
title: "ADR 0019: Refresh rotation versus suspension — lock order is decided with the status-change code"
owner: identity-team
service: identity-service
status: accepted
date: 2026-10-04
diataxis: explanation
last_verified: 2026-10-04
tags: [adr, decision, refresh-token, suspension, concurrency]
related: [auth-spec, users-tasks, adr-0002-asymmetric-jwt-rotating-refresh, adr-0005-refresh-reuse-grace-window]
---

# ADR 0019 — Refresh rotation versus suspension: lock order

- **Status:** Accepted • **Date:** 2026-10-04 • **Deciders:** identity-team

## Context
`SessionService.rotate` locks the presented token row (`FOR UPDATE`) and then reads the user without a lock. A
concurrent suspension that updates `users.status` and then runs `UPDATE refresh_tokens ... WHERE user_id = $1 AND
revoked_at IS NULL` can commit while the rotation inserts its successor, leaving one live successor token whose
next use is refused but which first mints one access token (<= 15 min, ADR 0002). The suspending code (admin
route and `PATCH /internal/users/:id/status`) is not built yet.

## Decision
Do **not** add a user-row lock to `rotate` now. A `SELECT ... FOR SHARE` on the user after the token lock would
acquire locks in the order token -> user, while the natural suspension order is user -> tokens; the two would
deadlock instead of serialising. The lock order must be fixed once, with both sides in view.

The `users` and `internal-users` modules must therefore implement the status change as: lock the user row
(`SELECT ... FOR UPDATE`) first, update status, write the history row, then revoke all families; and `rotate` must
be changed in the same unit to lock in the same order (read the token's `user_id` without a lock, lock the user
`FOR SHARE`, then lock the token `FOR UPDATE`, re-check the token is still unrevoked). A concurrency test (suspend
versus refresh) accompanies that change. This is recorded as a task in `docs/users/tasks.md`.

## Consequences
- Until then the residual window is one access token of at most 15 minutes after a suspension commits, which is
  inside the window already accepted in ADR 0002.
- No behaviour change in the auth module.
