---
title: "ADR 0011: PII is retained on soft delete in MVP"
owner: identity-team
service: identity-service
status: accepted
date: 2026-09-15
diataxis: explanation
last_verified: 2026-09-15
tags: [adr, decision, privacy, pii, retention, soft-delete]
related: [design-baseline, data-model, future]
---

# ADR 0011 — PII is retained on soft delete in MVP

- **Status:** Accepted • **Date:** 2026-09-15 • **Deciders:** identity-team (product owner decision)

## Context
Domain rule 9 soft-deletes accounts (`deleted_at`, revoke all tokens, free the email). The row, including email,
phone, full name, and avatar, is kept forever; no deletion route exists in PRD §14. Care references Identity user
ids from consultations and medical records, so the row and id must survive regardless. Anonymizing PII after a
grace period and self-service deletion were considered.

## Decision
- In MVP, a soft-deleted account **keeps its PII unchanged**. No anonymization job, no deletion endpoint.
- Soft-deleted users stay invisible to every read path (`whereNull('deleted_at')`) and are omitted from
  `/internal/users`, so Care shows its "no profile" fallback.
- The decision is revisited **before general availability or at the first privacy/legal review**, whichever comes
  first. The candidate design (ops-initiated delete, 30-day grace, worker anonymizes email/phone/name/avatar and
  makes the hash unusable, id and status history kept) is recorded in [future.md](../architecture/future.md).

## Consequences
- ➕ No additional scope or cross-service coordination in MVP.
- ➖ Indefinite retention of personal data without a stated purpose — a privacy liability that must be resolved
  before GA; breach impact includes deleted users.
- ➖ Right-to-erasure requests must be handled manually by ops until the follow-up ships.

## Alternatives considered
- **Ops-initiated delete + anonymization after 30 days** — recommended by the architect, deferred by the product owner.
- **Self-service `DELETE /api/auth/me` + anonymization** — rejected for MVP: new public route and cross-service
  handling of a deleted patient's upcoming consultations in Care.
