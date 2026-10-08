---
title: Identity Service — Service-to-Service Auth
owner: identity-team
service: identity-service
status: ready
diataxis: explanation
last_verified: 2026-10-08
tags: [architecture, service-auth, client-credentials, scopes, internal-api, security]
related: [system-design, auth-tokens, api, data-model, runbook, service-auth-spec, adr-0022-service-client-rotation-window-timing]
---

# Service-to-Service Auth

> **As built (2026-10-08):** the token endpoint, `serviceGuard`, the `service` policy kind and the provisioning
> scripts exist (module `service-auth`). The guarded routes (`/internal/users`, `/internal/users/{id}/status`)
> arrive with `internal-users`.

How care-service (and later the Phase-2 AI service) calls Identity's `/internal/*` API. Platform-wide
decision: hub ADR 0003 (service-token S2S auth). Identity is the token **issuer** for every vcare service,
including tokens other services verify (e.g. `doctors:read` for Care's internal summary).

## 1. Principles
- **No shared database, no static long-lived API keys.** Callers hold a client id and secret and exchange
  them for a **300-second** scoped JWT.
- `/internal/*` is served only by the internal listener (`INTERNAL_PORT`, private interface). Ingress never
  routes it. Network isolation is defence in depth — the token is still required.
- **The only principal is the verified token.** `X-User-Id`, `X-Role`, `X-Forwarded-User`, or any other
  caller-supplied identity header is ignored and never read by application code.
- A user token on an internal route is rejected with `401 ServiceTokenRequired` — **even an admin's**.

## 2. Client-credentials flow

```mermaid
sequenceDiagram
    autonumber
    participant Care as care-service
    participant T as Identity /internal/auth/token
    participant U as Identity /internal/users
    participant DB as Postgres
    Care->>T: POST grant_type=client_credentials, client_id=care-service, client_secret, scope="users:read users:status:write", audience=vcare-identity
    T->>DB: SELECT … FROM service_clients WHERE client_id = $1 AND deleted_at IS NULL
    T->>T: is_active? argon2id verify(secret)? scopes ⊆ allowed_scopes? audience ∈ allowed_audiences?
    T-->>Care: 200 { access_token (typ=service, exp=300s), token_type: Bearer, expires_in: 300, scope }
    Note over Care: cache token; re-exchange ~60 s before expiry
    Care->>U: GET /internal/users?ids=1,2,3  Authorization: Bearer <service token>  X-Request-Id
    U->>U: service-guard: EdDSA signature (kid), iss, typ=service, aud ∋ vcare-identity, exp, scope ∋ users:read
    U->>DB: SELECT … FROM users WHERE id = ANY($1) AND deleted_at IS NULL
    U-->>Care: 200 [ UserSummary … ]
```

Token endpoint rules (as built; spec [service-auth/spec.md](../service-auth/spec.md) section 3):
- Body is JSON or `application/x-www-form-urlencoded` (a route-scoped form parser, 100 kb): `grant_type`,
  `client_id`, `client_secret`, `scope` (space-separated, at most 256 chars), `audience` (at most 64 chars). Unknown
  fields are rejected (`400`); a validation error never echoes a value.
- Unknown client, soft-deleted client, disabled client (`is_active = false`), wrong secret, and an expired previous
  secret all return the same `401 InvalidCredentials`. A dummy argon2 verify runs when no real hash applies, so each
  costs one verify. Exception (accepted, ADR 0022): a wrong secret on a client inside an open rotation window
  verifies both the current and the previous hash, so it costs two.
- Scope and audience are judged only **after** the secret verified, so an unauthenticated caller learns nothing
  about a client's allow-lists. A requested scope outside `allowed_scopes` (including an unknown one) **or** an
  audience outside `allowed_audiences` → `403 InsufficientScope` (the same code for both). An empty or malformed
  `scope` is `400 ValidationFailed`.
- The granted scope is exactly the requested scope (de-duplicated, request order), never "all allowed". Scopes and
  audiences are independent allow-lists; there is no scope-to-audience coupling at issuance.
- Two Redis sliding-window limiters, both `degrade: "fallback"` (ADR 0008), run before body validation and
  hashing: **30/min per client IP** (`token-ip`, subject = `clientIp(req)`) and **60/min per `client_id`**
  (`token-client`; a missing or malformed `client_id` shares one constant `invalid` bucket so Redis key
  cardinality stays bounded). A trip returns `429 RateLimited` with `Retry-After`; a full argon2 queue
  (`HASH_QUEUE_MAX`) is also `429`. The IP limiter depends on `INTERNAL_TRUST_PROXY_HOPS`: production requires
  it to be set and `>= 1` (otherwise every caller shares the load balancer's address in one bucket).
- Response `200` carries `Cache-Control: no-store`, no refresh token and no `Set-Cookie`. `Idempotency-Key` is ignored.
- The secret verify is argon2id, so callers **must cache** the token for its lifetime (re-exchange about 60 s
  before `exp`) rather than exchanging per call, and honour `Retry-After` on `429`.
- `last_used_at` is touched at most once per minute per client, asynchronously after the response; a failed touch
  is logged `service_client_touch_failed` and never fails the exchange.

## 3. Service token claims
| Claim | Value |
|---|---|
| `iss` | `vcare-identity` |
| `sub` | `client_id` (e.g. `care-service`) |
| `typ` | `service` |
| `aud` | the requested audience as a **single string** (e.g. `vcare-identity`, `vcare-care`); the guard accepts a string or an array that contains `vcare-identity` |
| `scope` | granted scopes, space-separated (e.g. `users:read users:status:write`) |
| `iat`, `exp` | `exp = iat + SERVICE_TOKEN_TTL_SECONDS` (300) |
| `jti` | random UUID |

Signed with the same Ed25519 key set as user tokens and verifiable via `/.well-known/jwks.json`.

## 4. Scopes
| Scope | Grants | Enforced by | Typical holder |
|---|---|---|---|
| `users:read` | `GET /internal/users?ids=` (batch summaries; no email/phone) | identity-service | care-service |
| `users:status:write` | `PATCH /internal/users/{id}/status` | identity-service | care-service |
| `users:contact:read` | `GET /internal/users/contacts?ids=` (email, name, locale, status; **no phone**) | identity-service | **care-service only** — `chk_service_clients_contact_scope_care_only` in the database and the provisioning scripts refuse it for any other client ([ADR 0024](../adr/0024-notification-contacts-lookup-and-scope.md)); used by `care-worker` only |
| `doctors:read` | Care's `GET /internal/doctors/{userId}/summary` | care-service (Identity only issues it, with `aud=vcare-care`) | **no MVP service client holds it**; reserved for admin tooling and the Phase-2 ai-service once provisioned (hub `TODO.md`) |

Scopes are coarse and resource-oriented. A new scope requires a contract change (here or in the
enforcing service), an update to the `chk_service_clients_allowed_scopes` constraint, and a hub record.

## 5. `service-guard` rules
Applied to every `/internal/*` route **except** `/internal/auth/token` and `/internal/health`, followed by
`authorize(policy)` with the required scope:

1. `Authorization: Bearer <jwt>` present — else `401 ServiceTokenRequired`.
2. Signature valid for a `kid` in the key set (`alg` pinned to EdDSA) — else `401 ServiceTokenRequired`.
3. `iss = vcare-identity`, `exp` in the future (30 s skew); `exp`, `iat`, `sub` and `jti` are required claims — else
   `401 ServiceTokenRequired`. An expired service token is `ServiceTokenRequired`, not `TokenExpired`.
4. `typ = service` — a `typ=user` token → `401 ServiceTokenRequired`.
5. `aud` includes `vcare-identity` — else `401 ServiceTokenRequired` (a wrong audience is 401, not 403).
6. Required scope present in `scope` — else `403 InsufficientScope`. This step is `authorize(policy)` with a
   `{ kind: "service", scope, owner: "none" }` policy, not the guard itself.
7. Sets `req.auth = { kind: "service", clientId: sub, scopes }`; logs carry `clientId` (only after the signature
   verified).

The guard performs no I/O (no database, no Redis): a client disabled or soft-deleted while holding a token keeps
working until that token's `exp` (at most 300 s), the same accepted residual shape as ADR 0002. As built, no
production route uses the guard yet (`internal-users` adds the first two); the module's tests mount a probe router.

Data in the body is **data, not authorization**: `actorUserId` on a status change is recorded in
`user_status_changes.actor_user_id` and never used to grant anything. The service identity recorded is the
token's `sub` (`actor_service`).

## 6. Provider guarantees for internal endpoints
- No outbound calls; p95 < 50 ms.
- `PATCH /internal/users/{id}/status` accepts `status` `active | rejected | pending | suspended`
  (`pending` = Care re-opened a rejected application). Care may apply `pending → active|rejected`,
  `rejected → pending`, `active → suspended`; `suspended → active` is admin-only on the public API and not
  propagated to Care in MVP.
- It is idempotent (same status → 200, no history row; already `suspended` still ensures no live refresh
  tokens), so Care's Case 3 "retry until success" loop is safe on timeouts and 5xx.
- Any other pair → `409 InvalidStatusTransition`, which is **non-retryable**: Case 3 against a target that
  is not `active` signals drift between the services, so Care alerts instead of retrying.
- Batch lookup returns `fullName` (provider field name); consumers may rename it (Care exposes `displayName`).
- The caller's `X-Request-Id` is adopted, logged, and stored on `user_status_changes.request_id`.
- Changes to `/internal/*` shapes are breaking for Care: update `contracts/openapi.yaml` first, keep the old
  shape until Care ships against the new one, record it in the hub.

## 7. Onboarding a new service client (example: Phase-2 ai-service)
The AI service is a **new client with its own scopes**, not a change to Identity's code paths.

1. **Design:** run `/system-design` for the integration; decide the minimal scopes and audiences (e.g.
   `doctors:read` with `aud=vcare-care`). If a new Identity scope is needed, change
   `contracts/openapi.yaml` and add a migration extending `chk_service_clients_allowed_scopes` first.
2. **Record:** update the hub (`../vcare-hub/architecture/landscape.md`, `data-ownership.md`) and this repo's
   [service-card.md](../service-card.md) "Called by" table.
3. **Provision** (ops procedure, not an API): `npm run service-client:sql -- --client-id ai-service …` prints the
   `INSERT` (argon2id hash, `allowed_scopes`, `allowed_audiences`, `is_active=true`) to stdout and a fresh
   256-bit secret once to stderr; ops runs the SQL with `psql -f`. Store the plaintext secret only in the AI
   service's secret manager entry; it is never logged, committed, or retrievable afterwards. Steps:
   [runbook.md](../runbook.md) → Provision a service client.
4. **Verify:** from the AI service's network, exchange credentials, call one allowed route (expect 200) and
   one route outside its scopes (expect `403 InsufficientScope`); confirm a user token gets
   `401 ServiceTokenRequired`.
5. **Operate:** secret rotation follows [runbook.md](../runbook.md) → Rotate a service client secret.
   Offboarding sets `is_active=false` (tokens die within 300 s) and later `deleted_at`.

## 8. Secret rotation model
A client can hold a current and a previous secret hash during an overlap window
(`previous_secret_hash`, `previous_secret_expires_at` on `service_clients`; the two are set or null together).
The token endpoint verifies the current hash first and, only if that fails and `previous_secret_expires_at` is in
the future, the previous hash, so the caller can roll its secret without downtime. `--rotate` defaults to a 24 h
overlap (maximum 168 h); `--rotate --leaked` writes no overlap, so the old secret stops working at once. See
[data-model.md](./data-model.md) and the runbook.

Timing and logging consequences (ADR 0022): a wrong secret on a client inside an open window costs two argon2id
verifies instead of one (accepted residual; the caller is an internal client behind the per-IP and per-client
limiters). When the current secret fails and the previous secret is already past its expiry, the denial is logged
with reason `secret_expired` without verifying the expired hash, so it is only a hint ("wrong secret on a client whose
window has closed"), not proof that the old secret was presented. Alert on `bad_secret` plus `secret_expired`
together. Denial reasons on the token route: `unknown_client | inactive | bad_secret | secret_expired | scope |
audience` (metric `service_token_denied`, dimension `reason`).
