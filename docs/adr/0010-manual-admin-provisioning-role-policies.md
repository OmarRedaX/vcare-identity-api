---
title: "ADR 0010: Manual admin provisioning; role-based policies separate from authentication"
owner: identity-team
service: identity-service
status: accepted
date: 2026-09-15
diataxis: explanation
last_verified: 2026-09-15
tags: [adr, decision, admin, rbac, authorization, security]
related: [design-baseline, auth-tokens, api, runbook, future, adr-0003-argon2id-password-hashing]
---

# ADR 0010 — Manual admin provisioning; role-based policies separate from authentication

- **Status:** Accepted • **Date:** 2026-09-15 • **Deciders:** identity-team (product owner decision)

## Context
Admins cannot self-register; CLAUDE.md said they come from an unspecified "seed/ops procedure", and admin MFA is
out of scope. A provisioning CLI with set-password links, MFA, and shorter admin token lifetimes were proposed and
**deferred** to keep MVP scope small. Authorization must remain deny-by-default and easy to extend with new roles.

## Decision
**Provisioning (MVP):**
- Ops inserts the admin row directly in the identity database through an audited DB session tied to a ticket:
  `role='admin'`, `status='active'`, `email_verified_at=now()`, and a `password_hash` that is the **argon2id hash
  of 64 random bytes that are immediately discarded** (an unusable password).
- The admin sets their own password with the existing `POST /api/auth/forgot-password` → `POST /api/auth/reset-password`
  flow. Nobody else ever knows it. Requires working email delivery in that environment.
- Removing admin rights: update `role`/`status` in the same audited way, then revoke sessions
  (`DELETE /api/users/{id}/sessions`). Existing access tokens keep the old role for ≤ 15 min (ADR 0002).
- No `user_status_changes` row at creation (initial state is not a change); the ops ticket is the record.

**Authentication vs authorization (unchanged design, now explicit):**
- `lib/auth/user-guard` **authenticates** only: verifies the token and sets `req.auth = { userId, role, status, ev }`.
- `lib/rbac/authorize(policy)` **authorizes** only, after the guard, on every route; deny by default.
- A policy lists roles **explicitly** — e.g. `{ roles: ["patient", "doctor", "admin"], owner: "self" }` or
  `{ roles: ["admin"], owner: "none", accountState: "active" }`. There is **no "any authenticated user"
  wildcard**, so a future role gains access to nothing until policies name it.
- Adding a role = migration widening `chk_users_role` + enum value + edits to the policies that should allow it;
  the middleware does not change.

**Deferred:** provisioning CLI, set-password invitation links, admin MFA (first post-MVP security item), shorter
admin access/refresh TTLs, new-device alerts.

## Consequences
- ➕ Zero new code or dependencies; no password is ever chosen or seen by ops.
- ➕ Explicit role lists keep deny-by-default true as roles are added.
- ➖ An admin account is protected by a password alone until MFA ships.
- ➖ Creation is a manual, ticket-audited DB operation — error-prone at scale and not visible in `user_status_changes`.
- ➖ First-password setup depends on the email path (outbox worker + provider).

## Alternatives considered
- **Audited CLI + set-password link + compensating controls (5 min / 12 h admin TTLs)** — deferred by the product owner.
- **CLI + mandatory admin TOTP now** — deferred: pulls MFA (out of scope) into MVP.
- **Ops sets a known argon2id hash and hands over the password** — rejected: a second person knows the password.
- **Seed script or migration** — rejected: credentials/hashes in the repo or deploy logs, environment-unsafe.
