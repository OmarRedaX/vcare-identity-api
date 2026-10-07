---
title: Identity Service — Runbook
owner: identity-team
service: identity-service
status: draft
diataxis: how-to
last_verified: 2026-10-07
tags: [runbook, operations, on-call, identity]
related: [service-card, auth-tokens, service-auth, infrastructure, deployment, foundation-manual-qa]
---

# Runbook — identity-service

On-call guide. Task-oriented; assumes the service is deployed. Identity is **Tier 1**: an outage stops
all logins and refreshes platform-wide, and blocks Care's Case 3 suspensions (Care retries and alerts).

> Status (2026-10-07): the `foundation`, `auth` and `users` modules are built — health probes, graceful shutdown,
> structured logs, the Redis-down behaviour, the auth flows, the outbox worker, and the admin status/session
> routes used below are real. Service-auth and internal-users are not built yet: their alerts and procedures are the
> contract for the ops work done when those modules land.

## At a glance
| | |
|---|---|
| Health (public) | `GET /api/health/live` → `200 {"status":"ok"}` (process only, never 503); `GET /api/health/ready` → `{ status: ok \| degraded \| down, checks: { database, redis } }` — 503 with `down` only when Postgres is down or the task is shutting down; Redis down alone → 200 `degraded` (ADR 0014) |
| Health (internal) | same pair on the internal listener: `/internal/health/live`, `/internal/health/ready` (private network, no token) |
| Health probe checks | readiness runs Postgres `SELECT 1` and Redis `PING` concurrently, 500 ms each; the edge never routes health |
| Availability target | 99.95 % monthly; RPO 0 (AZ) / ≤ 5 min; RTO ≤ 5 min (AZ) / ≤ 4 h (region) — ADR 0009 |
| Topology | `identity-api` ×2..6, `identity-worker` ×1 — [architecture/deployment.md](./architecture/deployment.md); platform view: hub `architecture/deployment.md` |
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
| `HealthCheckFailing` | readiness 503 for 2 min | Postgres unreachable, or tasks stuck in shutdown (the probe has its own connection, so request-pool saturation alone does not fail readiness) | read `checks` in the body (`database: down` vs. shutdown with both `up`) and the `readiness_failed` warn log (`checks`, `shuttingDown`); check DB connectivity, credentials, and a Multi-AZ failover in progress; a shutdown that overruns `SHUTDOWN_TIMEOUT_MS` logs `shutdown_timeout` with `unfinishedRequests`. Redis alone never fails readiness (ADR 0014). During a Postgres outage Knex also logs `knex_warn` lines (`detail: Acquire connection error …`) — expected, not a second incident |
| `RateLimiterDegraded` | `rate_limiter_degraded` for 2 min | Redis unreachable or failing over | check managed Redis status and `redis_error` / `redis_connect_failed` logs; readiness shows `redis: down` with 200 `degraded`; credential routes run on stricter per-task limits (ADR 0008) and idempotency is skipped (`idempotency_skipped`) — watch `AuthFailureSpike`, tighten WAF rules if an attack coincides. The client reconnects on its own; no restart needed. If Redis is connected but silent, look for `redis_breaker_open` (warn, once per trip) followed by a steady stream of `rate_limiter_degraded` / `idempotency_skipped` with no `redis_error`: the breaker is open and skips Redis for `REDIS_BREAKER_COOLDOWN_MS` (default 15 s), then logs `redis_breaker_half_open` and either `redis_breaker_closed` (recovered) or `redis_breaker_open` again (still unresponsive). Repeated open/half-open cycles mean Redis is wedged: fail over or restart it; the service needs no restart |
| `OutboxLagHigh` | oldest pending outbox job > 2 min for 5 min | worker down, email provider slow/erroring, DB contention | check `identity-worker` task health and logs (`last_error` classes); scale worker to 2; if the provider is down, registration codes and resets are delayed — post a status notice |
| `OutboxDeadJobs` | any job in `dead` | persistent provider rejection (bad address, auth) | `SELECT type, last_error, count(*) FROM outbox_jobs WHERE status='dead' GROUP BY 1,2;` fix the cause; re-queue with `UPDATE … SET status='pending', attempts=0, run_after=now()` via the audited ops console |
| `DbPoolSaturated` (planned: pool metrics are not emitted yet) | pool wait p95 > 200 ms for 5 min | traffic spike, slow queries, too few tasks | check slow-query log and `EXPLAIN` hot paths; scale out `identity-api`; confirm purge batches are not running unthrottled |

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
  blocks bookings — Identity's admin route refuses doctor targets with `403` (ADR 0012); for patients,
  `PATCH /api/users/<id>/status` with `{ "status": "suspended", "reason": "…" }`.
- Remember the residual window: already-issued access tokens stay valid for up to 15 minutes.
- Reinstating a **patient** (`suspended → active`) is admin-only via `PATCH /api/users/<id>/status`. Reinstating a
  **doctor** has no API path in MVP: open an incident ticket and coordinate with care-service on-call to update both
  services' databases through the audited ops console.

### Create an admin account (MVP manual procedure — ADR 0010)
1. Open a ticket naming the person and approver. Use the audited ops DB session for the target environment.
2. Generate an **unusable** password hash — argon2id of 64 random bytes that are never printed or stored — with the
   service's hashing helper (planned script; until it exists, run the `argon2` library in a one-off container,
   reading randomness from `crypto.randomBytes`, printing only the encoded hash).
3. Insert the row with explicit values (no defaults on critical columns):
   `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at, timezone, locale) VALUES ('<email>', '<hash>', '<full name>', 'admin', 'active', now(), '<IANA tz>', '<locale>');`
4. Ask the admin to use **Forgot password** on the web app; the reset email sets their own password. Confirm
   delivery (no `OutboxDeadJobs` for `send_password_reset`).
5. Record the new user id in the ticket. **To remove admin rights:** update `role`/`status` in the same audited way,
   then `DELETE /api/users/<id>/sessions`; existing access tokens expire within 15 minutes.

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
