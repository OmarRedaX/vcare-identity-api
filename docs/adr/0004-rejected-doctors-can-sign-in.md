---
title: "ADR 0004: Rejected accounts can sign in and refresh"
owner: identity-team
service: identity-service
status: accepted
date: 2026-09-15
diataxis: explanation
last_verified: 2026-09-15
tags: [adr, decision, auth, account-status, cross-service]
related: [design-baseline, auth-tokens, api, landscape]
---

# ADR 0004 — Rejected accounts can sign in and refresh

- **Status:** Accepted • **Date:** 2026-09-15 • **Deciders:** identity-team

## Context
Care's contract lets a doctor whose application was rejected fix it and resubmit (`rejected → submitted`),
accepting a doctor token with `status=rejected`. Identity's rules said `suspended` and `rejected` accounts
cannot log in or refresh, and entering `rejected` revokes every refresh-token family. A rejected doctor could
therefore never obtain a token, and Care's resubmission route was unreachable — a cross-service contradiction.
`rejected` is only reachable through Care (Case 1), so it only ever applies to doctors.

## Decision
- `POST /api/auth/login` and `POST /api/auth/refresh` **accept** accounts with `status=rejected`; the access
  token carries `status=rejected`, exactly like `pending`.
- Entering `rejected` **still revokes all refresh-token families** in the same transaction, so the next login
  issues a token whose claims reflect the new status.
- Self routes (`GET/PATCH /api/auth/me`, `POST /api/auth/change-password`) accept `rejected`; admin routes still
  require `active`.
- `AccountRejected` is no longer returned by any Identity route; it stays reserved in the shared error catalogue.
- `suspended` is unchanged: no login, no refresh, `AccountSuspended`.

## Consequences
- ➕ Care's resubmission flow works as designed with no Care change; the doctor can read why they were rejected.
- ➕ Rejected and pending share one code path (onboarding-only tokens), simplifying guards.
- ➖ A rejected account keeps a working credential. Blast radius is small: Care authorizes rejected tokens only
  on onboarding routes, and Identity admin routes require `active`.
- ➖ Contract change on login/refresh error lists and on the account-state requirement of self routes.

## Alternatives considered
- **Admin reopen only** — keep rejected locked; Care's reopen (`→ pending`) restores login. Rejected: breaking
  change to Care's contract, admin toil, and the doctor cannot see the rejection reason.
- **Split `rejected` (resubmittable) from `banned` (terminal)** — rejected: a fifth status across Identity,
  tokens, and Care, while `suspended` already covers a terminal block.
