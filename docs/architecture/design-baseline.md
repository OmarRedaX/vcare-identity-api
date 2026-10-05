---
title: Identity Service — Design Baseline (requirements, API surface, data-model delta)
owner: identity-team
service: identity-service
status: accepted
diataxis: explanation
last_verified: 2026-09-16
tags: [architecture, system-design, requirements, api, data-model, decisions]
related: [system-design, capacity, deployment, api, data-model, auth-tokens, infrastructure, future, landscape]
---

# Design Baseline

Outcome of the full `/system-design` pass of **2026-09-15**, covering six stages: requirements gaps,
capacity, API surface, data model, high-level architecture, bottlenecks and DevOps. This shard holds the
**requirements decisions, the target API surface, the data-model delta, and every change they require**.
Identity's capacity derivation lives in [capacity.md](./capacity.md) and its runtime, SLOs, bottlenecks and
observability in [deployment.md](./deployment.md). The platform-scope outcomes — shared traffic assumptions,
deployment topology, release pipeline — are authored in the hub (`architecture/capacity.md`,
`architecture/deployment.md`; hub ADR 0008).

> Status of the contract: `contracts/openapi.yaml` has **not** been changed yet. Until it is (via
> `/construct-spec` + `/develop`), the contract still describes the pre-baseline API, and
> [api.md](./api.md) mirrors it. Section 4 is the change list.
>
> **Update 2026-09-16:** the health split (section 4, item 7) was applied to the contract on 2026-09-15 and built
> by the `foundation` module. The remaining items are still pending; the paragraph above holds for them.

## 1. Requirement gaps and decisions

| # | Gap found | Decision | Record |
|---|---|---|---|
| D1 | Care lets a `rejected` doctor resubmit, but Identity blocked rejected accounts from login/refresh — resubmission was unreachable | `rejected` accounts **can log in and refresh** (token `status=rejected`); entering `rejected` still revokes all sessions; Identity no longer returns `AccountRejected` | [ADR 0004](../adr/0004-rejected-doctors-can-sign-in.md) |
| D2 | Concurrent refreshes from two tabs trip reuse detection and log the user out | **10 s grace window**: re-presenting a token rotated < 10 s ago whose successor is still unused → `401 RefreshTokenInvalid`, no family revocation; web client single-flights refresh | [ADR 0005](../adr/0005-refresh-reuse-grace-window.md) |
| D3 | `POST /auth/register` → `409 Conflict` enumerates accounts (health-adjacent PII) while forgot/resend hide it | **Email-first two-step registration**: `register/start` (always 202) → `register/complete` with proof | [ADR 0006](../adr/0006-email-first-registration-otp.md) |
| D4 | Proof mechanism; fate of verify-email flow | **6-digit code**, HMAC-SHA256 with `OTP_PEPPER`, 10 min, 5 attempts; accounts are born verified; `verify-email`, `resend-verification`, `email_verifications` **removed**; `ev` claim kept (always `true`) | [ADR 0006](../adr/0006-email-first-registration-otp.md) |
| D5 | "Queued email" had no mechanism; background jobs had no home | **Postgres transactional outbox** (`outbox_jobs`) + separate **worker** deployment; worker generates codes/tokens at send time; purges under advisory lock | [ADR 0007](../adr/0007-transactional-outbox-worker.md) |
| D6 | Credential-route limiters failed closed on Redis outage → Redis was silently Tier 1 | **Per-instance fallback limiter** (stricter) + alert; idempotency falls back to DB constraints; Redis is **Tier 2** | [ADR 0008](../adr/0008-redis-tier-2-fallback-limiter.md) |
| D7 | No availability / RPO / RTO targets | **99.95 %** monthly; single region, multi-AZ; sync standby + PITR; cross-region snapshot copies; RPO 0 (AZ) / ≤ 5 min (corruption); RTO ≤ 5 min (AZ) / ≤ 4 h (region) | [ADR 0009](../adr/0009-availability-and-recovery-targets.md) |
| D8 | Refresh cookie `SameSite=Strict; Path=/api/auth` presumes a domain topology nobody chose | **Single origin**: edge path-routes Identity and Care prefixes; no CORS in production | hub [ADR 0005](../../../vcare-hub/adr/0005-single-origin-edge-routing.md) |
| D9 | Admin provisioning undefined; admin MFA deferred | **Manual DB insert** of `role='admin'` with an unusable argon2id hash; admin sets the password via forgot/reset. Authorization = `authorize(policy)` with **explicit role lists** (no "any authenticated" wildcard), separate from `user-guard`. CLI, MFA, shorter admin TTLs deferred | [ADR 0010](../adr/0010-manual-admin-provisioning-role-policies.md) |
| D10 | Soft delete keeps PII indefinitely; no erasure policy | **Keep PII on soft delete** in MVP (explicit, revisit before GA) | [ADR 0011](../adr/0011-pii-retained-on-soft-delete.md) |
| D11 | Admin status change of a **doctor** in Identity is invisible to Care (known gap) | Identity's admin status route **refuses doctor targets** (`403 Forbidden`); doctor account status changes only through Care (Cases 1, 3) | [ADR 0012](../adr/0012-doctor-status-only-via-care.md), hub [ADR 0006](../../../vcare-hub/adr/0006-doctor-account-status-via-care-only.md) |
| D12 | No capacity baseline | Size for **500 k registered / 50 k DAU**; verify the design holds at 10× | hub [capacity.md](../../../vcare-hub/architecture/capacity.md) (assumptions), [capacity.md](./capacity.md) (Identity derivation) |
| D15 | No hosting platform | **Managed containers** (reference: AWS ECS on Fargate) — platform-wide | hub [ADR 0007](../../../vcare-hub/adr/0007-managed-container-platform.md) |
| D16 | No metrics/tracing approach | **Log-derived metrics** (embedded metric format), `X-Request-Id` for cross-service tracing; no new dependency | [ADR 0013](../adr/0013-log-derived-metrics.md) |
| D17 | Health 503 on Redis loss would drain every task (self-inflicted outage) | Split **liveness / readiness**; readiness fatal on Postgres only | [ADR 0014](../adr/0014-health-liveness-readiness-split.md) |

D13 (API surface) and D14 (data model) are the approvals of sections 2 and 3.

## 2. Target API surface (approved)

Bodies are defined later by `/construct-spec`; this is the endpoint inventory.

### Public — `https://vcare.example`, edge-routed to Identity
| Endpoint | Purpose | Change vs current contract |
|---|---|---|
| `POST /api/auth/register/start` | submit email; always `202`; queues a 6-digit code (new email) or an "account exists" notice (known email) | **new** |
| `POST /api/auth/register/complete` | email + code + password + profile → verified account `201`; `Idempotency-Key` required | **new — replaces `POST /api/auth/register`** |
| `POST /api/auth/login` | credentials → access token + `vcare_rt` cookie; `pending` and `rejected` accounts allowed | changed (D1) |
| `POST /api/auth/refresh` | rotate cookie, issue access token; 10 s grace | changed (D2) |
| `POST /api/auth/logout` | revoke the presented token's family, clear cookie | — |
| `POST /api/auth/forgot-password` | always `204`; queues reset email (also the admin first-password path) | note (D9) |
| `POST /api/auth/reset-password` | reset token + new password; revokes all families | — |
| `POST /api/auth/change-password` | current + new password; revokes other families | — |
| `GET /api/auth/me` | own account | allowed for `rejected` (D1) |
| `PATCH /api/auth/me` | update `fullName`, `phone`, `avatarUrl`, `timezone`, `locale` | allowed for `rejected` (D1) |
| `GET /api/users` | admin list, filters `role`/`status`/`email`, cursor pagination | — |
| `GET /api/users/{id}` | admin get one | — |
| `PATCH /api/users/{id}/status` | admin suspend/reinstate — **patients only**; doctor or admin target → `403 Forbidden` | changed (D11) |
| `GET /api/users/{id}/sessions` | admin list live families | — |
| `DELETE /api/users/{id}/sessions` | admin revoke all families | — |
| `GET /.well-known/jwks.json` | public signing keys | — |
| `GET /api/health/live`, `GET /api/health/ready` | liveness / readiness (not routed by the edge) | **replaces `GET /api/health`** (D17) |
| ~~`POST /api/auth/register`~~, ~~`POST /api/auth/verify-email`~~, ~~`POST /api/auth/resend-verification`~~ | — | **removed** (D3, D4) |

### Internal — private network, service token
| Endpoint | Purpose | Change |
|---|---|---|
| `POST /internal/auth/token` | client credentials → 300 s service token | — |
| `GET /internal/users?ids=` | batch profile lookup ≤ 100 ids (Case 2) | — |
| `PATCH /internal/users/{id}/status` | Care-driven status change (Cases 1, 3) | — |
| `GET /internal/health/live`, `GET /internal/health/ready` | liveness / readiness | **replaces `GET /internal/health`** (D17) |

## 3. Data-model delta (approved)

Full definitions: [data-model.md](./data-model.md) (updated with this baseline).

| Table | Change |
|---|---|
| `email_verifications` | **removed** (D4) |
| `registration_challenges` | **new** — `email CITEXT`, `code_hash CHAR(64) NULL` (HMAC hex), `attempts SMALLINT` 0..5, `expires_at`, `consumed_at`, `invalidated_at`, `created_at` |
| `outbox_jobs` | **new** — `type`, `aggregate_id`, `status` (`pending`/`processing`/`done`/`dead`), `attempts`, `run_after`, `locked_until`, `last_error`, `request_id`, timestamps; no PII or secrets in rows |
| `password_resets` | `token_hash` and `expires_at` **nullable until the worker sends**; `chk_password_resets_token_sent`; unique index becomes partial |
| `users`, `refresh_tokens`, `service_clients`, `user_status_changes` | unchanged (admins are ordinary `users` rows; grace window uses existing columns) |

Retention (worker): `refresh_tokens` 30 d after expiry/revocation · `password_resets` 30 d ·
`registration_challenges` 24 h · `outbox_jobs` `done` 7 d / `dead` 30 d · `users` PII kept on soft delete (D10).

## 4. Required contract changes (`contracts/openapi.yaml`; provider: identity-service)

Land via `/construct-spec auth` (and `users`, `health`) → `/develop`. **Care's contract is unaffected**: no
`/internal/*` shape changes.

> **Status (2026-09-16):** all items are applied to the contract. Item 7 (applied 2026-09-15) is built by the
> `foundation` module ([foundation/spec.md](../foundation/spec.md) §3, §15). Items 1–6, 8, and 9 (applied
> 2026-09-16) are contract-only until the registration, auth, and users modules are built.

1. Remove `POST /api/auth/register`, `POST /api/auth/verify-email`, `POST /api/auth/resend-verification`.
2. Add `POST /api/auth/register/start` — `202`; errors `ValidationFailed`, `IdempotencyConflict`, `RateLimited`; rate limits 3/h per email, 5/h per IP; `x-roles: public`.
3. Add `POST /api/auth/register/complete` — `201 User`; `Idempotency-Key` **required**; errors `ValidationFailed` (incl. invalid/expired/exhausted code, `field: code`), `Conflict` (concurrent registration race only), `IdempotencyConflict`, `RateLimited`; rate limit 10/h per IP (spec default — confirm in `/construct-spec`).
4. `POST /api/auth/login`, `POST /api/auth/refresh`: remove `AccountRejected`; describe `status=rejected` tokens. `GET/PATCH /api/auth/me`, `POST /api/auth/change-password`: allow `rejected`.
5. `POST /api/auth/refresh`: document the 10 s grace behaviour (`RefreshTokenInvalid`, no family revocation).
6. `PATCH /api/users/{id}/status`: target `role=doctor` (and `admin`, already) → `403 Forbidden`; remove the "Known gap" description.
7. Replace `GET /api/health` and `GET /internal/health` with `…/health/live` and `…/health/ready` (ready: Postgres fatal, Redis reported as `degraded`, never `503` on its own).
8. Access-token `ev` description: always `true` for accounts created by `register/complete`.
9. Error catalogue: `AccountRejected` becomes "reserved, not returned by Identity" (like `AccountPending`).

## 5. `CLAUDE.md` edits (applied 2026-09-15, together with the `rbac-ownership-guard` skill in both spokes)

| Section | Edit |
|---|---|
| Mission of this service | "Email verification" → "email ownership proof at registration"; admins "created manually by ops (ADR 0010)" |
| Database rules | expected tables: drop `email_verifications`, add `registration_challenges`, `outbox_jobs`; secrets list: `registration_challenges.code_hash` (HMAC-SHA256 with `OTP_PEPPER`) |
| API conventions | `Idempotency-Key` required on `POST /api/auth/register/complete`; health endpoints `…/health/live`, `…/health/ready`; `AccountRejected` reserved |
| Authentication and service-to-service auth | refresh: 10 s grace window rule (ADR 0005) |
| Authorization — RBAC and ownership | route table: `register/start`, `register/complete` replace register/verify/resend; `PATCH /users/:id/status` "patients only"; self routes allow `rejected`; policies list roles explicitly, no wildcard |
| Security rules | rate limits for register start/complete; one-time tokens: registration code (10 min, 5 attempts, HMAC) replaces email verification; Redis-down fallback limiter (ADR 0008) |
| Cross-service integration | replace "Known gap" with ADR 0012 / hub ADR 0006 |
| Domain rules | 1 (registration via start/complete, born verified), 2 (removed), 5 (`rejected` can log in), 6 (+ admins cannot change a doctor's status) |
| Testing policy | mandatory scenarios: grace window vs reuse; doctor target refused; register enumeration-uniform 202; Redis-down fallback |
| Tech stack / Folder structure | add `src/worker.ts` entrypoint and `lib/outbox/` |

## 6. Cross-repo follow-ups

Platform-scope follow-ups (PRD §14 appendix, hub re-sync after the contract changes land, Care's health
readiness split and its empty capacity/availability roll-up rows) are tracked in the hub `TODO.md`, not here
(hub ADR 0008). No Care contract change is required.

## 7. Explicitly deferred

Admin provisioning CLI, admin MFA, shorter admin token TTLs (ADR 0010) · PII anonymization and self-service
account deletion (ADR 0011) · doctor reinstatement propagation (ADR 0012) · OpenTelemetry tracing (ADR 0013) ·
`refresh_tokens` partitioning, connection proxy, secondary email provider ([deployment.md](./deployment.md)) ·
self-service session list/revoke ([future.md](./future.md)).
