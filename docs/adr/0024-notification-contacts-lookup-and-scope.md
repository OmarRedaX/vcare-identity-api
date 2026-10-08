---
title: "ADR 0024: GET /internal/users/contacts and the care-service-only users:contact:read scope"
owner: identity-team
service: identity-service
status: accepted
date: 2026-10-08
diataxis: explanation
last_verified: 2026-10-08
tags: [adr, decision, internal, pii, service-auth, scope, notifications]
related: [service-auth, api, adr-0021-reason-field-not-redacted-in-logs, hub-adr-0010]
---

# ADR 0024 — `GET /internal/users/contacts` and the `users:contact:read` scope

- **Status:** Accepted • **Date:** 2026-10-08 • **Deciders:** identity-team, with platform-team (hub ADR 0010)

## Context

Care sends transactional email (booking confirmation, reminders) from its own outbox but must not store email
addresses; Identity is their single writer. Hub [ADR 0010](../../../vcare-hub/adr/0010-notification-contact-lookup.md)
(Case 5) decided that Care's `care-worker` resolves recipients at send time through a narrow Identity lookup, and
that Identity ships the provider side first. The hot Case-2 endpoint (`GET /internal/users`) is cached by Care and
must stay free of email and phone.

## Decision

- **Endpoint:** `GET /internal/users/contacts?ids=` (1..100 comma-separated ids, else `400 ValidationFailed`)
  returns `[{ id, email, fullName, locale, status }]`. **No phone.** One query,
  `WHERE id = ANY($1) AND deleted_at IS NULL`; unknown or soft-deleted ids are omitted. No outbound calls.
- **Scope:** new service scope `users:contact:read`, added to the scope vocabulary
  (`SERVICE_SCOPES`, the `ServiceScope` type) and to `chk_service_clients_allowed_scopes`.
- **Grantable only to `care-service`:** enforced in the database by
  `chk_service_clients_contact_scope_care_only` (`'users:contact:read' = ANY(allowed_scopes)` implies
  `client_id = 'care-service'`) and, earlier and with a clearer message, by the provisioning and seed scripts. The
  token endpoint already refuses a scope outside the client's `allowed_scopes`, so no other client can obtain it.
- **No caching, no logging of addresses:** the response is `Cache-Control: no-store`. Identity logs the request
  (route, client id, status, duration) and the number of ids, never an address or name; the logger already
  redacts `email`, `fullName` and `phone` by key as defence in depth, and the code never passes them.
- **Budget:** p95 < 50 ms for 100 ids (primary-key lookup, same plan as the batch lookup).

## Consequences

- Good: Care owns its notification templates; Identity stays the single writer and a leaf; PII exposure is one
  endpoint, one scope, one caller, no persistence on the Care side.
- Cost: a second PII-bearing internal endpoint to protect; the scope check is the only barrier on the internal
  network, so the care-only `CHECK` exists to stop a mis-provisioned client from ever holding it.
- Cost: adding a second client that needs contacts needs a new ADR and a migration that relaxes the `CHECK`.

## Alternatives considered

- **Add `email` to `GET /internal/users`** — rejected (hub ADR 0010): hot, cached path.
- **Enforce "care-service only" in code at token issue** — rejected: a table `CHECK` cannot be bypassed by a
  forgotten code path or a hand-written SQL insert.
- **Identity sends the emails** — rejected (hub ADR 0010).
