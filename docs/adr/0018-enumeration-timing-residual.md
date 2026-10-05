---
title: "ADR 0018: Known-versus-unknown email work differs by a few milliseconds (accepted residual)"
owner: identity-team
service: identity-service
status: accepted
date: 2026-10-04
diataxis: explanation
last_verified: 2026-10-04
tags: [adr, decision, security, enumeration, registration, password-reset]
related: [auth-spec, adr-0006-email-first-registration-otp, adr-0007-transactional-outbox-worker, adr-0017-password-reset-by-one-time-code]
---

# ADR 0018 — Known-versus-unknown email work differs by a few milliseconds

- **Status:** Accepted • **Date:** 2026-10-04 • **Deciders:** identity-team

## Context
`register/start` and `forgot-password` return an identical status, body and headers for known and unknown
emails (CLAUDE.md -> Security rules, no account enumeration). The database work behind them is not identical:
`forgot-password` does no write for an unknown email and a three-statement transaction for a known one;
`register/start` differs in the other direction (a challenge insert plus job versus a job only). The code review of
2026-10-04 asked for either equalised work or an explicit acceptance.

## Decision
Accept the residual. Do not add dummy writes or a no-op outbox job.
- The difference is a handful of single-row statements on a local database (low single-digit milliseconds), far
  below internet jitter, so a remote attacker cannot separate the two cases with useful confidence.
- Both routes are limited per email (3/h) and per IP, so statistical averaging over many samples is bounded.
- Equalising by writing for unknown emails would create junk rows and outbox jobs for arbitrary strings (a
  storage-amplification and email-bomb surface), which is the larger risk.
- Equalising by moving the work to the worker would change the transaction and outbox contract (ADR 0007) for
  no measurable gain.

## Consequences
- The status, body and header sets stay identical and are asserted by integration tests.
- Revisit if the endpoints ever run without per-email limiting, or if measurements show a separable difference.
