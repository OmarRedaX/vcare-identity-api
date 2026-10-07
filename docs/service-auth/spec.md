---
title: service-auth — Spec
owner: identity-team
service: identity-service
module: service-auth
status: ready
version: 1.1.0
diataxis: reference
last_verified: 2026-10-07
tags: [spec, service-auth, client-credentials, service-guard, service-clients, internal-listener, rate-limit, provisioning]
related: [service-auth-brainstorm, service-auth, data-model, api, auth-tokens, infrastructure, runbook, quickstart, auth-spec, users-spec, adr-0002-asymmetric-jwt-rotating-refresh, adr-0003-argon2id-password-hashing, adr-0008-redis-tier-2-fallback-limiter, adr-0010-manual-admin-provisioning-role-policies, adr-0012-doctor-status-only-via-care, adr-0014-health-liveness-readiness-split]
contracts: [contracts/openapi.yaml]
---

# service-auth — Spec

Source of truth for the HTTP shape is [`contracts/openapi.yaml`](../../contracts/openapi.yaml) (operation
`issueServiceToken`, plus the two `/internal/health/*` operations that already exist). On any disagreement the
contract wins and this spec is stale. Intent: [brainstorm.md](./brainstorm.md). Architecture background:
[architecture/service-auth.md](../architecture/service-auth.md).

This is the first of two modules for Integration Cases 1-3. It delivers the **machinery** that every `/internal/*`
route needs. The two guarded routes (`GET /internal/users`, `PATCH /internal/users/{id}/status`) belong to the later
`internal-users` module and are **not** specified here.

## 1. Overview

### 1.1 What the module owns
- Table `service_clients` (registered callers of `/internal/*`) and its repository.
- `POST /internal/auth/token`: the OAuth 2.0 client-credentials grant that returns a 300-second EdDSA service token.
- `lib/auth/service-guard.ts` (authentication of a service token) and the `service` policy kind in
  `lib/rbac` (authorization by scope), so `internal-users` only has to write
  `router.<verb>(path, serviceGuard, authorize(policy), handler)`.
- Internal listener wiring for the token route (urlencoded body parsing, per-IP and per-client limiters, `no-store`).
- Verification that `/internal/health/live|ready` behave per contract on the internal listener (already built by the
  `foundation` module; this module adds tests and no new code for them).
- Ops provisioning: a one-off script that **prints** the SQL (no CLI, no API), a dev-only seed script, and the runbook
  sections that use them.

### 1.2 Principles
- The only principal on an internal route is the **verified service token**. `X-User-Id`, `X-Role`,
  `X-Forwarded-User` and any other identity header are never read.
- A user token on a guarded internal route is `401 ServiceTokenRequired`, **even an admin's**; a service token on a
  public `/api/*` route is already `401 Unauthorized` (`userGuard` requires `typ=user`) and stays so.
- `service-guard` does **no I/O** (no DB, no Redis): it verifies a signature. The token endpoint does one indexed read
  and one argon2id verify.
- Unknown client, wrong secret, disabled client, soft-deleted client: indistinguishable `401 InvalidCredentials`
  (same body, same cost: one argon2id verify each).
- Fail closed: a route with no `authorize(...)` stops the process at boot on the internal listener too.

### 1.3 Dependencies
- **auth (as-built):** `TokenSigner`, `SigningKeySet` (`lib/auth`), `PasswordHasher` + `Semaphore`
  (`HASH_CONCURRENCY`, `HASH_QUEUE_MAX`), `rateLimit` / `consumeRateLimit` (`lib/rate-limit`), `authorize`
  (`lib/rbac`), `lib/validation`, `Clock`, request context, `noStore`, `clientIp`.
- **foundation (as-built):** `createInternalApp`, `assertRoutesAuthorized`, health router, error handler.
- **Other service:** none called. Care is the caller (Cases 1-3 start with this exchange). No outbound calls.
- **Used by (later):** `internal-users`, and any future internal route.

### 1.4 Decisions (resolve the contract/doc ambiguities)
- **D-1 Disallowed audience → `403 InsufficientScope`** (same code as a disallowed scope; `architecture/service-auth.md`
  already says so). Evaluated only **after** the secret verified, so an unauthenticated caller learns nothing about a
  client's allowed lists.
- **D-2 Token `aud` is a single string** (the requested audience), per contract and CLAUDE.md. The guard accepts a
  string or an array containing `vcare-identity` (jose semantics).
- **D-3 Wrong `aud` on a guarded route → `401 ServiceTokenRequired`** (service-auth.md step 5), not 403.
- **D-4 Expired service token → `401 ServiceTokenRequired`** (not `TokenExpired`, which is the user-token code).
- **D-5 `service_clients.is_active`** is the disabled marker (no `disabled_at`; brainstorm Q1 corrected). A client
  disabled while holding a token keeps working for at most 300 s because the guard reads no database (accepted
  residual, same shape as ADR 0002).
- **D-6 Granted scope = requested scope** (de-duplicated, request order), never "all allowed". An empty or
  pattern-invalid `scope` is `400`; a well-formed scope outside `allowed_scopes` (including an unknown one such as
  `foo:bar`) is `403 InsufficientScope`.
- **D-7 No scope-to-audience coupling at issuance.** `allowed_audiences` and `allowed_scopes` are independent
  allow-lists; the enforcing service checks `aud` and its own scopes. (A `users:read` token with `aud=vcare-care` is
  useless against Identity because the guard demands `aud ∋ vcare-identity`.)
- **D-8 Token TTL is a constant** `SERVICE_TOKEN_TTL_SECONDS = 300` in `lib/auth/constants.ts`, **not** an env var
  (the contract fixes `expires_in` as `const 300`; same reasoning as the user-token constants). No new env var is
  introduced by this module.
- **D-9 Two limiters on the token route** (brainstorm Q2): per IP **30/min** and per `client_id` **60/min**, both
  `degrade: "fallback"` (ADR 0008). Numbers in section 3.2.
- **D-10 `client_secret_hash` must be argon2id** (DB `CHECK`), so the bcrypt-verify path in `PasswordHasher` can never
  be reached for a client; a `needsRehash` result is ignored (ops re-hashes through rotation).
- **D-11 `last_used_at` is touched asynchronously** after the response is sent, by one conditional `UPDATE`
  (section 3.3 step 8). It never delays or fails a token response.

### 1.5 File list
```
src/app/service-auth/
  controller/service-auth.controller.ts
  service/service-auth.service.ts            # issueToken(command)
  repository/service-client.repo.ts          # findLiveByClientId, touchLastUsed
  entity/service-client.entity.ts
  dto/service-auth.request.dto.ts            # ServiceTokenRequestDto
  dto/service-auth.response.dto.ts           # ServiceTokenResponseDto
  enums.ts  errors.ts  types.ts  policies.ts  routes.ts
src/lib/auth/service-guard.ts                # serviceGuard(deps)
src/lib/auth/jwt.ts                          # + TokenSigner.signServiceToken, verifyServiceAccessToken
src/lib/auth/constants.ts                    # + SERVICE_TOKEN_TTL_SECONDS, SERVICE_SCOPES, SERVICE_CLIENT_ID_PATTERN
src/lib/rbac/types.ts, authorize.ts          # + { kind: "service"; scope; owner: "none" } policy
src/lib/error/errors.ts                      # + ServiceTokenRequired (401), InsufficientScope (403)
src/lib/config/env.schema.ts                 # production refinement for INTERNAL_TRUST_PROXY_HOPS (section 5.2)
src/lib/di/tokens.ts, src/bootstrap.ts       # register ServiceAuthService, ServiceAuthController
src/internal-routes.ts                       # mount /auth
src/migrations/20261007000300_create_service_clients.ts
scripts/provision-service-client.ts          # prints SQL (INSERT or rotation UPDATE); no DB connection
scripts/seed-service-client.ts               # dev-only upsert of a synthetic client; refuses NODE_ENV=production
scripts/service-client-args.ts               # shared argument validation + SQL builder (pure, unit-tested)
package.json                                 # + "service-client:sql", "seed:service-client"
```
Module files follow CLAUDE.md → Module file conventions. `lib/` imports no `app/` module: the guard and the policy
kind use only `lib` types and constants.

## 2. Database schema

### 2.1 `20261007000300_create_service_clients.ts`
Raw SQL, real `down` (`DROP TABLE IF EXISTS service_clients`). Matches
[data-model.md](../architecture/data-model.md) → `service_clients`, **plus** the two rotation columns that doc
mentions only in prose.

| Column | Type | Null | Constraint |
|---|---|---|---|
| `id` | `BIGSERIAL` | no | `PRIMARY KEY` |
| `client_id` | `VARCHAR(64)` | no | `chk_service_clients_client_id` `client_id ~ '^[a-z][a-z0-9-]{2,63}$'` |
| `name` | `VARCHAR(120)` | no | `chk_service_clients_name_not_blank` `length(btrim(name)) > 0` |
| `client_secret_hash` | `VARCHAR(255)` | no | `chk_service_clients_secret_hash_argon2id` `client_secret_hash LIKE '$argon2id$%'` |
| `previous_secret_hash` | `VARCHAR(255)` | yes | `chk_service_clients_previous_hash_argon2id` `previous_secret_hash IS NULL OR previous_secret_hash LIKE '$argon2id$%'` |
| `previous_secret_expires_at` | `TIMESTAMPTZ` | yes | `chk_service_clients_previous_secret_pair` `(previous_secret_hash IS NULL) = (previous_secret_expires_at IS NULL)` |
| `allowed_scopes` | `TEXT[]` | no | `chk_service_clients_allowed_scopes` `allowed_scopes <@ ARRAY['users:read','users:status:write','doctors:read']::text[]`; `chk_service_clients_allowed_scopes_nonempty` `cardinality(allowed_scopes) >= 1` |
| `allowed_audiences` | `TEXT[]` | no | `chk_service_clients_allowed_audiences_shape` `allowed_audiences::text ~ '^\{vcare-[a-z0-9-]+(,vcare-[a-z0-9-]+)*\}$'` (the array's text form quotes any element with a special character, so a malformed element fails the match; also rejects empty arrays and NULL elements) |
| `is_active` | `BOOLEAN` | no | no default (the provisioning SQL always sets it) |
| `secret_rotated_at` | `TIMESTAMPTZ` | yes | |
| `last_used_at` | `TIMESTAMPTZ` | yes | touched at most once per minute per client (D-11) |
| `created_at` | `TIMESTAMPTZ` | no | `DEFAULT now()` |
| `updated_at` | `TIMESTAMPTZ` | no | `DEFAULT now()`; ops statements set it explicitly |
| `deleted_at` | `TIMESTAMPTZ` | yes | soft delete; frees the `client_id` |

No FK in or out (`user_status_changes.actor_service` references `client_id` logically, by design).

Indexes:
- `uq_service_clients_client_id` — `UNIQUE (client_id) WHERE deleted_at IS NULL`. Serves the only read:
  `SELECT <SERVICE_CLIENT_COLUMNS> FROM service_clients WHERE client_id = $1 AND deleted_at IS NULL`
  (token endpoint). The partial unique index lets a soft-deleted `client_id` be reused. No other index: the table has a
  handful of rows and the touch uses the primary key.

Enum-like, secret and array handling follow CLAUDE.md → Database rules (no native ENUM, no plaintext secret, no
`SELECT *`, `TIMESTAMPTZ` only). The scope vocabulary in the `CHECK` and in `lib/auth/constants.ts`
(`SERVICE_SCOPES`) must stay equal; a unit test asserts it.

### 2.2 Repository (`service-client.repo.ts`)
Exported functions taking `conn: Knex = db`, explicit `SERVICE_CLIENT_COLUMNS` (never `SELECT *`), private `toEntity`:
- `findLiveByClientId(conn, clientId)` — the query above; the entity carries both hashes, so it is **never** passed to a
  DTO or a logger.
- `touchLastUsed(conn, id, now)` —
  `UPDATE service_clients SET last_used_at = $2 WHERE id = $1 AND deleted_at IS NULL AND (last_used_at IS NULL OR last_used_at < $2 - interval '1 minute')`.
  Primary-key update, no `updated_at` change (usage is not a modification).
No insert/update/delete of clients exists in application code: provisioning is ops SQL (section 6).

## 3. API contract

### 3.1 Common to the token route
- Listener: **internal only** (`INTERNAL_PORT`); mounted by `internal-routes.ts` at `/internal/auth`. A request to the
  public listener is `404` (the public app never imports the module).
- Every response (success, error, `429`) carries `Cache-Control: no-store` (`noStore()` first on the router) and
  `X-Request-Id`.
- Wire fields are snake_case (OAuth 2.0), inside the standard envelope.

### 3.2 `POST /internal/auth/token`
- **Guard:** none (the caller has no token yet). The principal is the client credentials in the body, checked by the
  service. Policy: `publicPolicy` kind (`{ kind: "public", owner: "none" }`) so the boot check proves every route has an
  `authorize(...)`; contract `x-roles: [service]`, `x-ownership: none`, `x-scope: none`.
- **Roles:** `service` (a client authenticating by credentials). A user bearer token sent here is **ignored**
  (the route reads no `Authorization` header and issues nothing based on it).
- **Ownership predicate:** none. The client can only obtain scopes/audiences in its **own** row's allow-lists.
- **Idempotency-Key:** not supported and not required (each exchange mints a new token); the header is ignored. The
  idempotency middleware is not mounted.
- **Middleware order (as in `routes.ts`):**
  `noStore()` → `limiter(token-ip)` → `express.urlencoded({ extended: false, limit: "100kb", type: "application/x-www-form-urlencoded" })`
  (route-scoped; the JSON parser is already app-level) → `limiter(token-client)` → `authorize(tokenEndpointPolicy)` →
  `controller.issueToken`. Limiters run before validation and hashing.
- **Limiters** (Redis sliding window, `degrade: "fallback"`, fallback limit `max(1, floor(limit / RATE_LIMIT_FALLBACK_DIVISOR))`,
  i.e. 15 and 30 with the default divisor 2; `Retry-After` on every `429`):

  | Name | Limit | Window | Subject |
  |---|---|---|---|
  | `token-ip` | 30 | 1 min | `clientIp(req)` (first; needs no body) |
  | `token-client` | 60 | 1 min | `body.client_id` if it is a string matching `^[a-z][a-z0-9-]{2,63}$`, else the constant `invalid` |

  Rationale: Care exchanges roughly once per ~4 min per task (it caches), so legitimate load is far below both. The IP
  limiter stops a caller that varies `client_id` to dodge the per-client counter; the constant `invalid` subject keeps
  Redis key cardinality bounded for garbage input. Residual (accepted, internal network only): a caller inside the
  network can exhaust `care-service`'s 60/min bucket by spamming bad secrets; the IP limiter bounds one host, and the
  alert `AuthFailureSpike` plus `service_token_denied` logs surface it.
- **Request DTO `ServiceTokenRequestDto`** (`forbidNonWhitelisted: true`; JSON or form body; every field required):

  | Field | Rules |
  |---|---|
  | `grant_type` | `@Equals("client_credentials")` |
  | `client_id` | `@IsString @Matches(/^[a-z][a-z0-9-]{2,63}$/)` |
  | `client_secret` | `@IsString @Length(32, 256)` |
  | `scope` | `@IsString @Matches(/^[a-z]+(:[a-z]+)+( [a-z]+(:[a-z]+)+)*$/)` and `@MaxLength(256)` (see C-2) |
  | `audience` | `@IsString @Matches(/^vcare-[a-z0-9-]+$/)` and `@MaxLength(64)` (see C-2) |

  A form body with a repeated key yields an array and fails `@IsString` (`400`). An unsupported content type leaves
  `req.body` undefined and fails validation (`400`). Malformed JSON → `400 ValidationFailed` through the error handler.
  `details[].field` names the field; the **value is never echoed** (it may be a secret).
- **Response `200`** (`sendSuccess`; the contract uses 200, not 201): `data = { access_token, token_type: "Bearer", expires_in: 300, scope }`.
  No refresh token, no `Set-Cookie`.
- **Status / error codes** (contract: `ValidationFailed, InvalidCredentials, InsufficientScope, RateLimited, InternalError`):

  | Status | Code | When |
  |---|---|---|
  | 400 | `ValidationFailed` | DTO invalid, malformed JSON, unsupported content type |
  | 401 | `InvalidCredentials` | unknown client, soft-deleted client, `is_active = false`, wrong secret, or a previous secret past its expiry |
  | 403 | `InsufficientScope` | a requested scope not in `allowed_scopes`, or the audience not in `allowed_audiences` (after the secret verified) |
  | 429 | `RateLimited` | `token-ip` or `token-client` tripped (`Retry-After` seconds), or the hash queue is full (`HashQueueFull`, as login) |
  | 500 | `InternalError` | unhandled |

### 3.3 Issue algorithm (`ServiceAuthService.issueToken`)
No transaction (one read, no write on the request path).
1. DTO already validated; normalize the scope list: split on single spaces, de-duplicate, keep first-seen order.
2. `findLiveByClientId(client_id)`.
3. If the row is absent or `is_active = false`: run `PasswordHasher.verifyDummy(client_secret)` and throw
   `InvalidCredentials`. (Same cost as a real verify.)
4. `PasswordHasher.verify(client_secret_hash, secret)`. If it fails **and** `previous_secret_hash IS NOT NULL` **and**
   `previous_secret_expires_at > clock.now()`, verify the previous hash too. Neither matches → `InvalidCredentials`.
   Both verifies run behind the `HASH_CONCURRENCY` / `HASH_QUEUE_MAX` semaphore; a full queue → `429 RateLimited`.
   (A client inside a rotation window costs two verifies on a wrong secret; ops-only, accepted.)
5. Every requested scope ∈ `allowed_scopes`, else `InsufficientScope`.
6. `audience` ∈ `allowed_audiences`, else `InsufficientScope`.
7. Sign with `TokenSigner.signServiceToken`: header `{ alg: EdDSA, kid: activeKid, typ: JWT }`; claims
   `iss=vcare-identity`, `sub=client_id`, `typ=service`, `aud=<audience>` (string), `scope=<granted, space-joined>`,
   `iat` (from `Clock`), `exp = iat + 300`, `jti=<random UUID>`. Same Ed25519 key set as user tokens, verifiable at
   `/.well-known/jwks.json`.
8. After sending the response, `touchLastUsed(db, id, now)` fire-and-forget; a rejection is logged `warn`
   (`service_client_touch_failed`) and swallowed.
9. Log `service_token_issued` (info) with `clientId`, `audience`, `scope` (names only).

### 3.4 `serviceGuard` and the `service` policy (consumed by `internal-users` and later routes)
`serviceGuard(deps: { keys: SigningKeySet; clock: Clock })` — authentication only, no I/O, never reads an identity
header. Steps (all failures `401 ServiceTokenRequired`; the response never says which step failed, the log does):
1. `Authorization: Bearer <jwt>` present and well-formed.
2. Signature valid for a `kid` in `keys.verifyKeys`; `alg` pinned to EdDSA.
3. `iss = vcare-identity`; `exp` in the future with 30 s skew (`CLOCK_TOLERANCE_SECONDS`).
4. `typ = "service"`.
5. `aud` (string or array) includes `vcare-identity`.
6. Shape: `sub` matches the client-id pattern, `scope` is a string, `jti` is a string.
Then `req.auth = { kind: "service", clientId: sub, scopes: scope.split(" ") }` and the request context gets `clientId`.

`authorize(policy)` is extended with `{ kind: "service"; scope: SERVICE_SCOPE; owner: "none" }` (the `Policy` union in
`lib/rbac/types.ts`; `scope` is typed to the three known scopes and a policy naming another throws at boot):
- `req.auth` absent or `kind !== "service"` → `401 ServiceTokenRequired`.
- `scope` not in `req.auth.scopes` → `403 InsufficientScope` (log `access_denied`, reason `scope`).
Route shape for a guarded internal route: `router.<verb>(path, serviceGuard, authorize(policy), [validate], handler)`.
This module ships **no** production route using it; its integration tests mount a test-only probe router through the
existing `InternalAppOptions.extraInternalRouter` hook.

### 3.5 `GET /internal/health/live` and `GET /internal/health/ready`
Already built (foundation); specified here so this module's tests assert them on the internal listener.
- **Guard:** none. **Roles:** `public` (network isolation is defence in depth). **Ownership:** none.
  Probe-exempt from `authorize` (`markProbeExempt`, ADR 0014). **Idempotency-Key:** n/a. Not rate-limited.
- `live`: `200 { "status": "ok" }` bare (not enveloped), no dependency checks.
- `ready`: Postgres `SELECT 1` (500 ms) is fatal; Redis `PING` (500 ms) is reported only. `200` with
  `{ status: "ok" | "degraded", checks: { database, redis } }`; `503` with `status: "down"` when Postgres is down or
  shutdown is in progress. Redis down never fails readiness (ADR 0008).
- Both: `Cache-Control: no-store`, `X-Request-Id`. Error code in the contract: `InternalError` only (503 is a bare
  `HealthStatus`, not an envelope code; the public readiness operation is documented identically, so no contract change).

## 4. Business rules
| # | Rule | Enforced by |
|---|---|---|
| BR-1 | Unknown, soft-deleted, disabled client, wrong secret and an expired previous secret all return the same `401 InvalidCredentials` (same body, one argon2id verify each, dummy verify when no real hash applies). | `ServiceAuthService` steps 3-4 |
| BR-2 | `client_secret` is verified against `client_secret_hash`, or an unexpired `previous_secret_hash`; never compared with `===`, never logged. | `PasswordHasher`; step 4 |
| BR-3 | Hash work is bounded: a full queue is `429 RateLimited`, never an unbounded wait. | `Semaphore` (`HASH_CONCURRENCY`, `HASH_QUEUE_MAX`) |
| BR-4 | Scope/audience checks run only after the secret verified. | step order in 3.3 |
| BR-5 | Granted scopes are exactly the requested, de-duplicated scopes; each must be in `allowed_scopes`. | step 5; `chk_service_clients_allowed_scopes` |
| BR-6 | The requested audience must be in `allowed_audiences`; otherwise `403 InsufficientScope`. | step 6 |
| BR-7 | Token claims are `iss=vcare-identity`, `sub=client_id`, `typ=service`, `aud=<string>`, `scope`, `iat`, `exp=iat+300`, `jti`; no refresh token. | `TokenSigner.signServiceToken`; DTO |
| BR-8 | Tokens are signed with the active Ed25519 key and carry its `kid`; `alg` is pinned to EdDSA on verify. | `lib/auth/jwt.ts` |
| BR-9 | The token route is limited to 30/min per IP and 60/min per `client_id`, before validation and hashing; `429` carries `Retry-After`. | `rateLimit` ×2 in `routes.ts` |
| BR-10 | Redis down → in-process fallback limiter at `max(1, floor(limit / RATE_LIMIT_FALLBACK_DIVISOR))`; the token route keeps working. | `lib/rate-limit` (ADR 0008) |
| BR-11 | Every token response has `Cache-Control: no-store`. | `noStore()` |
| BR-12 | `serviceGuard` accepts only a verified `typ=service` token with `iss=vcare-identity`, an unexpired `exp` (30 s skew) and `aud ∋ vcare-identity`; everything else is `401 ServiceTokenRequired`, including a user token and an admin's. | `serviceGuard` |
| BR-13 | Identity headers (`X-User-Id`, `X-Role`, `X-Forwarded-User`, …) never influence `req.auth`. | `serviceGuard` reads only `Authorization` |
| BR-14 | A guarded route needs its scope in the token: missing → `403 InsufficientScope`. | `authorize` service kind |
| BR-15 | A route without `authorize(...)` on the internal router stops the process at boot. | `assertRoutesAuthorized` (internal app) |
| BR-16 | `/internal/*` is served only on the internal listener; the token route is absent from the public app. | `internal-routes.ts` only |
| BR-17 | The guard reads no database: a disabled/soft-deleted client's existing tokens work until `exp` (≤ 300 s). | design; runbook says so |
| BR-18 | `client_secret_hash` and `previous_secret_hash` are argon2id; the pair `previous_*` is set or null together. | `chk_service_clients_*` |
| BR-19 | `allowed_audiences` entries match `vcare-[a-z0-9-]+` and the array is non-empty; `allowed_scopes` is non-empty and ⊆ the vocabulary. | `chk_service_clients_*` |
| BR-20 | `last_used_at` advances at most once per minute per client and never delays a response. | `touchLastUsed` conditional `UPDATE`; async |
| BR-21 | Clients are never created, changed or deleted by application code or an API; only ops SQL. | no write functions in the repo |
| BR-22 | A soft-deleted client's `client_id` can be reused. | partial unique index |
| BR-23 | The production process refuses to start when `INTERNAL_TRUST_PROXY_HOPS < 1` (otherwise every Care task shares the LB's IP in the `token-ip` bucket). | env refinement (section 5.2) |
| BR-24 | Provisioning prints the plaintext secret once to stderr and never into the SQL; the SQL carries only the argon2id hash. | `scripts/provision-service-client.ts` |

## 5. Cross-service behavior, config, observability

### 5.1 Cross-service
- **Served:** the token exchange that precedes Cases 1, 2 and 3 (hub `landscape.md`). Care → `POST /internal/auth/token`.
- **Calls made:** none (no outbound call on any path of this module).
- **Failure policy:** **must not degrade to open.** If Identity is down, Care cannot get a token and its Case 1/3
  outbox retries; Care caches the token and re-exchanges ~60 s before `exp`, and honours `Retry-After` on `429`.
  Redis down degrades only the limiter. Care-side behaviour is Care's spec.
- `X-Request-Id` from the caller is adopted by the request-id middleware and logged.

### 5.2 Configuration
No new env var. Existing variables used: `INTERNAL_PORT`, `INTERNAL_HOST`, `INTERNAL_TRUST_PROXY_HOPS`,
`RATE_LIMIT_FALLBACK_DIVISOR` (default 2), `HASH_CONCURRENCY`, `HASH_QUEUE_MAX`, `JWT_PRIVATE_KEYS`, `JWT_ACTIVE_KID`,
`DATABASE_URL`, `REDIS_URL`. **Env change:** in `env.schema.ts`, when `NODE_ENV=production`, `INTERNAL_TRUST_PROXY_HOPS`
must be set explicitly and `>= 1` (same pattern as `TRUST_PROXY_HOPS`); infrastructure.md's "no IP-keyed decision uses
it yet" row is updated accordingly. Constants (not env): `SERVICE_TOKEN_TTL_SECONDS = 300`, `SERVICE_SCOPES`.

### 5.3 Logging and metrics
- Fields follow CLAUDE.md → Privacy and logging; `clientId` is allowed. On the token route `clientId` is logged only
  when it matches the client-id pattern. In the guard, `clientId` is logged only **after** the signature verified
  (never from an unverified token).
- Events: `service_token_issued` (info); `service_token_denied` (warn, metric `service_token_denied` with dimension
  `reason`) with `reason ∈ unknown_client | inactive | bad_secret | secret_expired | scope | audience` on the token route
  and `missing_token | malformed | bad_signature | unknown_kid | bad_issuer | expired | wrong_type | wrong_audience | bad_claims`
  in the guard; `access_denied` reason `scope` from `authorize`; `rate_limited`, `rate_limiter_degraded` (existing).
- Never logged: `client_secret`, hashes, the bearer token, the token response, the request body, `Authorization`
  (all redacted by key as defence in depth; callers do not pass them).

## 6. Provisioning and operations
Provisioning is an **ops procedure**, not an API (ADR 0010 precedent). No application code writes `service_clients`.

### 6.1 `scripts/provision-service-client.ts` (`npm run service-client:sql -- …`)
Prints SQL; **never connects to a database**. Arguments are validated with the same patterns/vocabulary as the
migration (`--client-id`, `--name`, `--scopes "a b"`, `--audiences "x y"`); invalid input exits 1 with a message that
names the argument, never a secret.
- **New client (default):** generates a 256-bit random secret (`crypto.randomBytes(32)` base64url, 43 chars), hashes it
  with `ARGON2_PARAMETERS`, prints to **stdout** a single `INSERT INTO service_clients (client_id, name, client_secret_hash, allowed_scopes, allowed_audiences, is_active, created_at, updated_at) VALUES (…, true, now(), now());`
  and prints the plaintext secret to **stderr** under a banner, once.
- **`--rotate [--overlap-hours N]` (default 24, max 168):** prints
  `UPDATE service_clients SET previous_secret_hash = client_secret_hash, previous_secret_expires_at = now() + interval 'N hours', client_secret_hash = '<new>', secret_rotated_at = now(), updated_at = now() WHERE client_id = '…' AND deleted_at IS NULL;`
  and the new secret on stderr. **`--leaked`** prints the same UPDATE with `previous_secret_hash = NULL, previous_secret_expires_at = NULL` (no overlap).
- Argon2 hashes contain `$`: the runbook says to redirect stdout to a file and run it with `psql -f` (never an unquoted
  shell heredoc).
- The secret goes straight to the caller's secret manager; it is never logged, committed, or recoverable.

### 6.2 `scripts/seed-service-client.ts` (`npm run seed:service-client -- …`, local dev only)
Defaults: `--client-id care-service --name "Care service (local)" --scopes "users:read users:status:write" --audiences vcare-identity`.
Refuses to run when `NODE_ENV=production`. Connects with `DATABASE_URL`, upserts the live row
(`ON CONFLICT (client_id) WHERE deleted_at IS NULL DO UPDATE` replacing the hash, clearing `previous_*`,
`is_active = true`) and prints the fresh random secret to stdout once. Synthetic data only; the secret is never stored
in the repo or a fixture. Integration tests do **not** use this script; they insert rows through a test helper that
hashes with the real `PasswordHasher`.

### 6.3 Runbook and docs (updated by `/update-docs`, listed here so the build task is complete)
Runbook: "Provision a service client" (6.1), "Rotate a service client secret" rewritten around `--rotate`, "Disable a
service client" (`UPDATE … SET is_active = false, updated_at = now()`; existing tokens die within 300 s), alert
guidance for `service_token_denied`. Quickstart section 5 drops "(planned)". `data-model.md` gains the two rotation
columns and the new `CHECK`s; `service-auth.md` section 2 gains the IP limiter, the 403-on-audience wording and the
form-parser note; `infrastructure.md` env table row for `INTERNAL_TRUST_PROXY_HOPS`.

## 7. Error codes
| Code | HTTP | When (this module) |
|---|---|---|
| `ValidationFailed` | 400 | token request DTO invalid, malformed JSON, unsupported content type |
| `InvalidCredentials` | 401 | unknown, soft-deleted, disabled client; wrong or expired-previous secret (BR-1) |
| `ServiceTokenRequired` | 401 | `serviceGuard`: missing/malformed/bad-signature/unknown-kid/wrong-issuer/expired token, `typ != service` (any user token), wrong `aud`; also `authorize` service kind with no service principal |
| `InsufficientScope` | 403 | token endpoint: scope or audience not allowed; `authorize`: token lacks the route's scope |
| `RateLimited` | 429 | `token-ip`, `token-client`, or hash queue full; `Retry-After` set |
| `InternalError` | 500 | unhandled (no internals in the body) |
No new code is introduced. `Unauthorized` remains the code for a service token presented on a public `/api` route.

## 8. Security & privacy
- **RBAC summary:** token route: credentials in body, no guard; guarded internal routes (later): `serviceGuard` +
  `authorize({ kind: "service", scope, owner: "none" })`; health: probe-exempt. No user role has any internal access.
- **Audit/log events:** section 5.3. There is no DB audit table for token issuance (volume is tiny; logs plus
  `last_used_at` suffice; status changes carry `actor_service` in their own module).
- **Never logged:** passwords, `client_secret`, any hash, bearer tokens, `Authorization`/`Cookie` headers, the token
  response, request bodies of `/internal/auth/token`, and any value from an unverified token.
- **Rate limits:** BR-9/BR-10. Limiters run before validation and hashing.
- **Secrets at rest:** argon2id only (BR-18). No static API keys, no shared database.
- **Network:** internal listener binds `INTERNAL_HOST` (private); ingress never routes `/internal`; the token is still
  required because network isolation is defence in depth.
- **Residuals (accepted):** disabled-client tokens live ≤ 300 s (BR-17); a network-internal caller can exhaust one
  client's bucket (section 3.2); no key pinning of the caller.
- **Files:** none (this module has no uploads).

## 9. Performance
- Token route: **1 query** (`uq_service_clients_client_id` index lookup), **1 argon2id verify** (2 in a rotation
  window on a wrong secret), 1 Redis script per limiter (2) with a 50 ms cap, plus 1 async primary-key `UPDATE`.
  Budget: p95 < 250 ms (argon2-dominated, same class as login); legitimate volume is a handful per minute
  (Care caches tokens), so the hash semaphore is never the bottleneck.
- `serviceGuard`: **0 queries, 0 Redis calls**, one Ed25519 verify (sub-millisecond); it must not consume the
  `/internal/users` p95 < 50 ms budget.
- `EXPLAIN` the lookup before merge: expected index scan on `uq_service_clients_client_id`.
- Health probes: as foundation (live no I/O; ready two 500 ms-capped pings).

## 10. Test plan outline
Names follow `should <do something> when <condition>`.

### 10.1 Unit (`tests/unit/`)
- `ServiceAuthService`: success returns de-duplicated requested scopes (BR-5); unknown client / disabled / wrong secret
  each run exactly one verify and throw the same `InvalidCredentials` (BR-1); unexpired previous secret accepted,
  expired rejected (BR-2); scope outside allow-list and audience outside allow-list → `InsufficientScope`, and neither
  is reached when the secret is wrong (BR-4, BR-6); full hash queue → `RateLimited` (BR-3); `touchLastUsed` failure does
  not fail the response (BR-20); `exp - iat = 300`, `aud` is a string, claims exactly as BR-7.
- `serviceGuard`: each of steps 1-6 and D-3/D-4 → `ServiceTokenRequired` (missing, malformed, bad signature, unknown
  kid, `alg: none`, wrong issuer, expired beyond skew, accepted within skew, `typ=user`, wrong `aud`, array `aud`
  including `vcare-identity` accepted); identity headers ignored (BR-13); no I/O performed.
- `authorize` service kind: no principal / user principal → 401; missing scope → 403; present scope → next; unknown
  scope in a policy throws at construction.
- `ServiceTokenRequestDto`: every field rule, extra property rejected, repeated form key rejected, secret not echoed.
- Limiter subject: valid client id vs `invalid` bucket.
- `SERVICE_SCOPES` equals the migration's `CHECK` list.
- Scripts: arg validation; new-client output has the hash in the SQL on stdout and the secret only on stderr
  (BR-24); `--rotate` and `--leaked` SQL shape; seed refuses `NODE_ENV=production`.
- Env: production without `INTERNAL_TRUST_PROXY_HOPS >= 1` fails (BR-23).
- Infra: DB down on the token route → `InternalError` 500 envelope with no internals.

### 10.2 Integration (`tests/integration/service-auth/`, real Postgres + Redis; mock nothing)
- Contract conformance for `issueServiceToken` (JSON and `application/x-www-form-urlencoded`): `200` shape,
  `Cache-Control: no-store`, `X-Request-Id`; `400/401/403/429` envelopes and codes; the issued JWT verifies against
  `/.well-known/jwks.json` and its claims match BR-7.
- `should return identical 401 InvalidCredentials when client is unknown, disabled, soft-deleted or secret wrong` (BR-1).
- Rotation: previous secret works until `previous_secret_expires_at`, then `401`; new secret works throughout (BR-2).
- Scope/audience matrix: subset ok; unknown scope `foo:bar` → 403; scope not allowed → 403; audience not allowed → 403;
  empty/invalid scope → 400; duplicate scopes de-duplicated.
- Rate limits: 61st request for one `client_id` → `429` with `Retry-After`; 31st request from one IP varying
  `client_id` → `429` (BR-9); garbage `client_id` shares the `invalid` bucket; with Redis stopped the fallback limiter
  decides and the route still works (BR-10) and readiness stays `200` (`degraded`).
- Hash queue full (`HASH_QUEUE_MAX=0`, saturated) → `429`, never a hang (BR-3).
- Guard + policy through the test-only probe router: no header, malformed, user token (patient, doctor, **admin**),
  expired token, wrong `aud`, wrong `typ`, unknown `kid`, tampered signature, `alg: none` → `401 ServiceTokenRequired`;
  token without the route scope → `403 InsufficientScope`; token with the scope → `200`; spoofed `X-User-Id` /
  `X-Role` change nothing (BR-12 to BR-14).
- A service token on a public `/api/users/me`-class route → `401 Unauthorized`.
- A route added without `authorize(...)` makes `createInternalApp` throw (BR-15).
- The token route is `404` on the public listener (BR-16).
- Disabled client: tokens issued earlier still pass the guard until `exp` (BR-17), new exchanges fail.
- `last_used_at`: set after the first success, not moved by a second success within a minute, moved after a minute
  with the fake clock (BR-20).
- Migration tests: each `CHECK` rejects bad rows (client id shape, scope vocabulary, empty arrays, audience shape,
  non-argon2id hash, `previous_*` pair), partial unique index frees a soft-deleted `client_id`, `down` drops the table.
- Health on the internal listener: `live` `200 {status: ok}`; `ready` `200` with Redis down (`degraded`) and `503`
  with Postgres down; both `no-store` and un-enveloped.
- No secret in any response body or log line: grep the captured log lines of a full flow for the plaintext secret, the
  hash and the issued token (none may appear).
- Request-id: a caller `X-Request-Id` is echoed and present on the `service_token_issued` log line.

### 10.3 RBAC matrix
Token route: reachable with no bearer; a bearer (user or service) is ignored. Guard probe route: service token with
scope allowed; service token without scope denied; user tokens of every role denied; no token denied. Health: open.

### 10.4 Manual QA (`/manual-qa service-auth`)
CURL the token route (JSON and form), every error code, the 429s, a wrong-audience and a user-token call to the probe
or, once `internal-users` exists, to its routes; run the provisioning script and a rotation end to end against a local
database; redact tokens and secrets in `manual-qa.md`.

## 11. Out of scope
- `GET /internal/users` and `PATCH /internal/users/{id}/status` (the `internal-users` module), including `actorUserId`
  handling and the Care transition table.
- Cases 4 (doctor reinstatement) and 5 (`users:contact:read`); any new scope or `doctors:read` client.
- A provisioning CLI or API, secret-rotation endpoints, static API keys, mTLS, client-certificate auth.
- Refresh tokens or token revocation lists for service tokens; token introspection endpoint.
- A DB audit table for token issuance; admin UI for clients.
- New runtime dependencies (none needed: `express.urlencoded` ships with Express 5; `jose`, `argon2` exist).

## 12. Open questions

None. The human accepted every decision in this spec (2026-10-07), including the limiter numbers (30/min per IP, 60/min per client).

## 13. Accepted follow-ups

### 13.1 Contract changes to apply in /develop step 0 (`contracts/openapi.yaml`; contract before code; accepted as non-breaking)
- **C-1 `issueServiceToken` description and `InsufficientScope` response text.** State that a requested audience outside
  `allowed_audiences` returns `403 InsufficientScope` (currently only scope is mentioned), that `aud` in the token is a
  single string, and that the limits are 30/min per IP **and** 60/min per `client_id` (`429` with `Retry-After`).
  Non-breaking for Care (no behaviour Care could have relied on differently).
- **C-2 `ServiceTokenRequest` hardening.** Add `maxLength: 256` to `scope` and `maxLength: 64` to `audience`
  (both already bounded in practice by `Care`'s fixed values); `client_id` and `client_secret` are already bounded.
  Non-breaking for any valid caller.

### 13.2 Platform follow-up (tracked in the hub `TODO.md` for a later /system-design; not blocking this module; hub docs are not edited here)
- **P-1 (accepted) Hub `architecture/landscape.md` (Case 1-3 provider notes) and `architecture/deployment.md`:** record that Care
  must cache the service token and re-exchange ~60 s before `exp`, honour `Retry-After` on the token route's `429`, and
  keep the client secret in its secret manager (rotated by the runbook's overlap procedure); and that the internal LB
  hop count (`INTERNAL_TRUST_PROXY_HOPS = 1`) is a deployment requirement because the token route limits by client IP.
