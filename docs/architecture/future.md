---
title: Identity Service — Deferred Work
owner: identity-team
service: identity-service
status: draft
diataxis: explanation
last_verified: 2026-09-14
tags: [architecture, future, roadmap, events, deferred]
related: [system-design, service-auth, auth-tokens, api]
---

# Deferred Work

Everything here is **out of scope for MVP** (CLAUDE.md → Out of scope). Each item needs a
`/system-design` session and an ADR before any code; items that add a runtime dependency need that ADR
first by rule.

## 1. Events: `user.registered`, `user.status_changed`
**Why it matters:** MVP is HTTP-only. When an admin changes a **doctor's** status directly via
`PATCH /api/users/{id}/status`, care-service is not notified — Care may keep a suspended doctor bookable,
or never learn that a doctor was reinstated. Two mitigations apply together in MVP:
1. the admin console routes doctor **suspension** through Care (`PATCH /admin/doctors/:id/suspend`), which
   calls `PATCH /internal/users/{id}/status` (Case 3);
2. Care reads `status` from batch hydration (`GET /internal/users?ids=`) and hides non-active doctors from
   search when that data is fresh.

**Reinstatement is not propagated (out of scope for MVP).** `suspended → active` is an admin-only action on
Identity's public API; the internal route rejects it. Care keeps its own suspension flags and upcoming
consultation follow-ups untouched, so a reinstated doctor stays blocked in Care until an event or a
Care-side reinstatement flow exists. Closing this is part of the same design topic below.

**Planned events** (also listed under `x-future-events` in the contract):

| Event | Emitted when | Payload | Primary consumer |
|---|---|---|---|
| `user.registered` | a user is created by register | `userId, role, status, occurredAt` | Care (create patient/doctor shell), notifications (welcome) |
| `user.status_changed` | any committed change to `users.status` | `userId, fromStatus, toStatus, actorUserId, actorService, reason, requestId, occurredAt` | Care (sync doctor eligibility; flag upcoming consultations on suspension) |

**Design constraints to settle in `/system-design`:**
- **Transactional outbox:** events are written to an `outbox` table in the same transaction as the status
  change and history row, then published by a relay — never published directly from the request.
- At-least-once delivery with an `eventId` for consumer idempotency; ordering per `userId`.
- An AsyncAPI contract (`contracts/asyncapi.yaml`) becomes a source of truth alongside OpenAPI, and the hub
  syncs it.
- Options to weigh: outbox + broker (hub decision on the bus), outbox + webhook to Care's internal API, or
  a design decision that makes Care the only writer of doctor status (removing the admin route for doctors).
- Cross-service: updates hub `architecture/landscape.md`, `data-ownership.md`, and likely a hub ADR.

## 2. Multi-factor authentication
TOTP first, then WebAuthn. Admin accounts are the first candidates (mandatory MFA for `role=admin`).
Implications: a `user_mfa_factors` table (secrets encrypted, recovery codes hashed), a two-step login
(`mfa_required` challenge token), rate limits on code verification, an `amr` claim in access tokens so Care
can require step-up for sensitive admin actions. New dependency (TOTP library) → ADR.

## 3. Social login / SSO
Google and Apple sign-in for patients; SSO is not planned for doctors. Implications: OIDC client flow
(PKCE), a `user_identities` table (`provider`, `provider_subject`, unique per provider), account linking
rules that never auto-link on unverified provider emails, and patients with no password (`password_hash`
becomes nullable only through a migration and ADR). Hosted auth products remain forbidden; this would be
first-party OIDC client code with `jose`.

## 4. Email change
Rejected by `PATCH /api/auth/me` in MVP. Future flow: request with current password → verification sent
to the **new** address and a notice to the **old** address → confirm within 24 h → swap `email`, reset
`email_verified_at`, revoke other sessions. Needs an `email_changes` table (token hash, new email as
CITEXT, expiry), a uniqueness check at confirm time, and a `user.email_changed` event if Care ever caches
emails (it must not in MVP — `UserSummary` excludes email).

## 5. Phase-2 AI service as a service client
The AI & Retrieval service (PRD §12) authenticates with the **existing** client-credentials flow as
`client_id=ai-service`. `doctors:read` is already issuable by Identity but **no MVP service client holds
it**; the AI service would be its first holder. Expected scopes: `doctors:read` (audience `vcare-care`) and possibly
`users:read` (audience `vcare-identity`) for display names. It never receives `users:status:write`.
No Identity code change is expected — onboarding follows [service-auth.md](./service-auth.md) §7. If the
AI booking agent acts **on behalf of a patient**, a delegated-token design (token exchange carrying both
the patient `sub` and the client `azp`) is a separate `/system-design` topic.

## 6. Smaller deferred items
- Per-session revoke (`DELETE /api/users/{id}/sessions/{familyId}`) and self-service `GET /api/auth/sessions`.
- Account soft-delete endpoint (self and admin) — domain rule exists, no route in PRD §14.
- Breached-password check against a k-anonymity range API instead of a local denylist.
- Signing keys in a KMS/HSM with remote signing instead of an env secret.
- Read replica for `GET /api/users` once admin listing load warrants it.
