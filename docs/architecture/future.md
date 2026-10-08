---
title: Identity Service — Deferred Work
owner: identity-team
service: identity-service
status: draft
diataxis: explanation
last_verified: 2026-10-08
tags: [architecture, future, roadmap, events, deferred]
related: [system-design, service-auth, auth-tokens, api, design-baseline, deployment]
---

# Deferred Work

Everything here is **out of scope for MVP** (CLAUDE.md → Out of scope). Each item needs a
`/system-design` session and an ADR before any code; items that add a runtime dependency need that ADR
first by rule.

## 1. Events: `user.registered`, `user.status_changed`
**Status (2026-09-15):** the former known gap — an admin changing a **doctor's** status in Identity without
Care knowing — is **closed by construction**: Identity's admin status route refuses doctor targets and doctor
status changes only through Care ([ADR 0012](../adr/0012-doctor-status-only-via-care.md), hub ADR 0006).
Events are still wanted for Care-side reactions to patient status changes, a future `user.registered` consumer,
(doctor reinstatement now has an API path: Case 4, [ADR 0023](../adr/0023-internal-status-accepts-suspended-to-active.md)).

**Reinstatement is no longer deferred.** Care initiates it (Case 4, hub ADR 0009): the internal route accepts
`suspended → active` ([ADR 0023](../adr/0023-internal-status-accepts-suspended-to-active.md), amending ADR 0012) and the
admin route still refuses doctor targets. A `user.status_changed` consumer remains a future option.

**Planned events** (also listed under `x-future-events` in the contract):

| Event | Emitted when | Payload | Primary consumer |
|---|---|---|---|
| `user.registered` | a user is created by register | `userId, role, status, occurredAt` | Care (create patient/doctor shell), notifications (welcome) |
| `user.status_changed` | any committed change to `users.status` | `userId, fromStatus, toStatus, actorUserId, actorService, reason, requestId, occurredAt` | Care (sync doctor eligibility; flag upcoming consultations on suspension) |

**Design constraints to settle in `/system-design`:**
- **Transactional outbox:** events are written to the existing `outbox_jobs` table (ADR 0007) in the same
  transaction as the status change and history row, then published by the worker — never directly from the request.
- At-least-once delivery with an `eventId` for consumer idempotency; ordering per `userId`.
- An AsyncAPI contract (`contracts/asyncapi.yaml`) becomes a source of truth alongside OpenAPI, and the hub
  syncs it.
- Options to weigh: outbox + broker, or outbox + webhook to Care's internal API. The choice of bus is a
  platform decision (hub ADR, tracked in hub `TODO.md` → Events); this repo only documents the events Identity emits.
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

## 6. Admin provisioning and hardening
Deferred by [ADR 0010](../adr/0010-manual-admin-provisioning-role-policies.md); MVP inserts admins manually and
they set their password through forgot/reset. Future, in priority order:
1. **Mandatory TOTP MFA for `role=admin`** (see §2) — the first post-MVP security item.
2. An audited provisioning CLI (private network, one-off task) that creates the admin with an unusable password
   and queues a set-password invitation through the outbox, writing an audit row with `actor_service='ops-cli'`.
3. Shorter admin token lifetimes (access 5 min, refresh 12 h), tighter admin login limit, new-device alert.

## 7. PII erasure
Deferred by [ADR 0011](../adr/0011-pii-retained-on-soft-delete.md) — revisit **before GA** or at the first
privacy/legal review. Candidate design: ops-initiated soft delete (revoke all tokens) → 30-day grace → worker
job anonymizes `email` (`deleted-<id>@invalid.vcare`), `phone`/`avatar_url` (`NULL`), `full_name`
(`Deleted user`), and replaces `password_hash` with an unusable value; the id and `user_status_changes` are kept
so Care's references stay valid. A self-service `DELETE /api/auth/me` is cross-service (Care must handle the
patient's upcoming consultations) and needs its own design.

## 8. Smaller deferred items
- Per-session revoke (`DELETE /api/users/{id}/sessions/{familyId}`) and self-service `GET /api/auth/sessions`.
- Account soft-delete endpoint (self and admin) — domain rule exists, no route in PRD §14.
- Breached-password check against a k-anonymity range API instead of a local denylist.
- Signing keys in a KMS/HSM with remote signing instead of an env secret.
- Read replica for `GET /api/users` once admin listing load warrants it.
- Monthly partitioning of `refresh_tokens` at ~10× the capacity baseline ([capacity.md](./capacity.md)).
- Connection proxy once `identity-api` exceeds ~10 tasks; secondary email provider for outbox failover.
- OpenTelemetry tracing, adopted jointly with care-service ([ADR 0013](../adr/0013-log-derived-metrics.md)).
