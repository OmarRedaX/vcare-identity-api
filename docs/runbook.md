---
title: Identity Service — Runbook
owner: identity-team
service: identity-service
status: draft
diataxis: how-to
last_verified: 2026-09-14
tags: [runbook, operations, on-call, identity]
related: [service-card, auth-tokens, service-auth, infrastructure]
---

# Runbook — identity-service

On-call guide. Task-oriented; assumes the service is deployed. Identity is **Tier 1**: an outage stops
all logins and refreshes platform-wide, and blocks Care's Case 3 suspensions (Care retries and alerts).

> Status: design (no code yet). Alert names and procedures are the contract for the observability and
> ops work done when the modules are built.

## At a glance
| | |
|---|---|
| Health (public) | `GET /api/health` → `{ status, checks: { database, redis } }` (200 / 503) |
| Health (internal) | `GET /internal/health` on the internal listener (private network) |
| Keys | `GET /.well-known/jwks.json` (must always return ≥ 1 key) |
| Latency SLOs (p95) | refresh < 50 ms · `/internal/users` (100 ids) < 50 ms · JWKS < 10 ms · login < 250 ms · other writes < 200 ms |
| Alert channel | `#alerts-identity` |
| Owner | identity-team |
| Logs | structured JSON; filter by `service="identity-service"` and `requestId` |

## Alerts → actions
| Alert | Condition | Likely cause | First action |
|---|---|---|---|
| `LoginLatencyHigh` | login p95 > 250 ms for 10 min | CPU saturation from argon2 (credential-stuffing burst or too few instances); slow `users` email lookup; Postgres pool exhaustion | check request rate and `login_failed` count; scale out instances; confirm rate limiter is tripping (`rate_limited` logs); check pool wait time and `EXPLAIN` of the email lookup. **Never lower argon2 parameters** to recover latency. |
| `RefreshReuseSpike` | `refresh_token_reuse_detected` > 20 in 5 min (or > 5× baseline) | stolen refresh tokens being replayed; or a client bug sending concurrent refreshes with the same cookie | group logs by `userId` and `route`; if concentrated on few users → treat as account compromise, revoke their sessions (below) and notify security; if spread across a client version → client bug, escalate to the web team. Families are already revoked automatically. |
| `AuthFailureSpike` | `401` rate on login > 5× baseline, or `InvalidCredentials` > 500/min | credential stuffing, brute force | confirm limiters are active (Redis healthy); identify top source IPs from ingress logs; block at ingress/WAF; watch for successful logins from the same sources and revoke those sessions |
| `InternalUsersLatencyHigh` | `/internal/users` p95 > 50 ms for 10 min | missing/unused index after a migration, large `ids` batches, DB contention, pool exhaustion | `EXPLAIN` the `id = ANY($1)` query; check pool saturation and slow-query log; Care degrades to cached profiles (Case 2) so this is not user-facing yet — fix before it becomes an outage |
| `JwksUnavailable` | `/.well-known/jwks.json` non-200 or empty `keys` from synthetic probe for 2 min | bad `JWT_PRIVATE_KEYS` deploy, process crash loop, ingress misroute | check the latest deploy and env validation errors at boot; roll back the config; consumers keep their cached JWKS for 5 min — after that, Care rejects every token |
| `HealthCheckFailing` | `/api/health` or `/internal/health` 503 for 2 min | Postgres or Redis unreachable | read `checks` to see which is `down`; check DB/Redis connectivity and credentials; with Redis down, credential routes fail closed (500) while refresh keeps working |

Additional signal to watch (no page): `service_token_denied` warnings — a spike usually means a Care
deploy with a rotated or wrong secret, or a user token sent to `/internal/*`.

## Common tasks

### Rotate the signing key (planned rotation)
Full rationale: [architecture/auth-tokens.md](./architecture/auth-tokens.md) → Key rotation procedure.
1. Generate an Ed25519 keypair as a JWK with a new `kid` (convention `identity-YYYY-MM`).
2. Append `{ kid, privateJwk }` to the `JWT_PRIVATE_KEYS` secret. Leave `JWT_ACTIVE_KID` unchanged. Deploy.
3. Verify: `curl -s https://<public-host>/.well-known/jwks.json` lists both `kid`s.
4. Wait ≥ 15 minutes (one access-token TTL; JWKS cache is 5 min).
5. Set `JWT_ACTIVE_KID` to the new `kid`. Deploy. Verify a fresh login token header has the new `kid`.
6. After the retirement window (30 days), remove the old key from `JWT_PRIVATE_KEYS`. Deploy. Verify JWKS.

**Compromised key:** perform steps 1, 2, and 5 in one deploy, then immediately remove the compromised
key, then revoke all sessions platform-wide
(`UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'admin_revoked' WHERE revoked_at IS NULL;`
via the audited ops console, with an incident ticket). Announce forced re-login in `#alerts-identity`.

### Rotate a service client secret (e.g. `care-service`)
Zero-downtime using the two-secret overlap ([architecture/service-auth.md](./architecture/service-auth.md) → Secret rotation model).
1. Generate a new ≥ 256-bit random secret.
2. Via the ops procedure, move the current `client_secret_hash` to `previous_secret_hash`, set
   `previous_secret_expires_at = now() + interval '24 hours'`, write the argon2id hash of the new secret to
   `client_secret_hash`, set `secret_rotated_at = now()`.
3. Update the caller's secret store with the new secret and redeploy the caller.
4. Confirm the caller obtains tokens: no `service_token_denied` warnings for its `clientId`; Care's internal
   calls succeed.
5. Clear `previous_secret_hash` and `previous_secret_expires_at` once confirmed (or let them expire).

**Leaked secret:** skip the overlap — write the new hash, clear `previous_secret_hash`, redeploy the caller.
Outstanding tokens die within 300 s. To cut a client off entirely, set `is_active = false`.

### Revoke a user's sessions
- Preferred (audited, API): as an admin,
  `curl -X DELETE https://<public-host>/api/users/<id>/sessions -H "Authorization: Bearer $ADMIN_TOKEN" -H "X-Request-Id: $(uuidgen)"` → 204.
- To also stop the account: suspend it. For a **doctor**, do it through Care's admin console (Case 3), so Care
  blocks bookings; for patients, `PATCH /api/users/<id>/status` with `{ "status": "suspended", "reason": "…" }`.
- Remember the residual window: already-issued access tokens stay valid for up to 15 minutes.
- Reinstating (`suspended → active`) is admin-only via `PATCH /api/users/<id>/status` and is **not**
  propagated to Care in MVP; for a doctor, tell care-service on-call so Care's side is handled manually.

### Trace a request by `X-Request-Id`
1. Get the id from the client response header or error body (`error.requestId`), or from Care's logs.
2. Search logs for `requestId="<id>"` across `identity-service` and `care-service`; the id is shared.
3. For status changes, the id is persisted: `SELECT user_id, from_status, to_status, actor_user_id, actor_service, created_at FROM user_status_changes WHERE request_id = '<id>';`
4. Log lines never contain tokens, emails, or bodies — use `userId` / `clientId` to pivot.

### Check whether Care's suspension landed (Case 3)
`SELECT status, updated_at FROM users WHERE id = <id>;` then
`SELECT count(*) FROM refresh_tokens WHERE user_id = <id> AND revoked_at IS NULL;` must be `0` for a
suspended user. If not, escalate immediately (security issue).

## Escalation
1. identity-team on-call (`#alerts-identity`).
2. Platform on-call for Postgres, Redis, ingress, or secret-manager incidents.
3. Security on-call for key compromise, secret leak, or confirmed refresh-token theft.
4. care-service on-call when Case 1/3 calls are failing from Care's side or Care shows mass `401` after a key change.
