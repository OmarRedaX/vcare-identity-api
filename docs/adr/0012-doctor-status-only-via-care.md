---
title: "ADR 0012: Identity's admin status route refuses doctor targets"
owner: identity-team
service: identity-service
status: accepted
date: 2026-09-15
diataxis: explanation
last_verified: 2026-09-15
tags: [adr, decision, account-status, cross-service, admin]
related: [design-baseline, api, landscape, adr-0004-rejected-doctors-can-sign-in]
---

# ADR 0012 — Identity's admin status route refuses doctor targets

- **Status:** Accepted; its reinstatement clause is amended by [ADR 0023](./0023-internal-status-accepts-suspended-to-active.md) • **Date:** 2026-09-15 • **Deciders:** identity-team, with platform-team (hub ADR 0006)

## Context
In the HTTP-only MVP, an admin changing a **doctor's** status through Identity's `PATCH /api/users/{id}/status`
was not propagated to Care: a doctor suspended in Identity lost sessions but could stay bookable in Care until
hydration hid them; a doctor reinstated in Identity stayed blocked in Care. The mitigations relied on UI
discipline. Platform-wide decision: hub [ADR 0006](../../../vcare-hub/adr/0006-doctor-account-status-via-care-only.md).

## Decision
- `PATCH /api/users/{id}/status` returns **`403 Forbidden`** ("doctor account status is managed by care-service")
  when the target has `role='doctor'`. With the existing rules (not self, not another admin), the public admin
  status route now applies to **patients only** (`active ↔ suspended`).
- Doctor account status changes only through `PATCH /internal/users/{id}/status`, driven by Care (Cases 1 and 3).
  Transitions and the internal contract are unchanged.
- Reinstating a suspended doctor has **no API path** in MVP (already out of scope); if needed it is an incident-ticket
  ops procedure performed in both services' databases together.

## Consequences
- ➕ Closes the known gap by construction; no events, no callbacks; Identity stays a leaf with no outbound calls.
- ➕ Existing error code; contract change is a description plus a test.
- ➖ Admins cannot act on a doctor account in Identity directly, even in an emergency — they must use Care's admin
  console (suspension) or ops (reinstatement).

## Alternatives considered
- **Outbox callback to a new Care internal endpoint** — real sync and future reinstatement; rejected for MVP:
  cross-service contract, new failure policy, and Identity would need a service client to call Care.
- **Keep the mitigations** — rejected: safety depends on UI routing; any direct API call reopens the gap.
