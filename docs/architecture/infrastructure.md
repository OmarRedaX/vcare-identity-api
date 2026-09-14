---
title: Identity Service — Infrastructure and Cross-Cutting Concerns
owner: identity-team
service: identity-service
status: draft
diataxis: reference
last_verified: 2026-09-14
tags: [architecture, infrastructure, env, logging, health, rate-limit, shutdown]
related: [system-design, overview, auth-tokens, runbook, quickstart]
---

# Infrastructure and Cross-Cutting Concerns

## 1. Environment variables (`src/lib/config/env.ts`, zod)
Every variable is declared in the zod schema. **Secrets have no defaults.** The process refuses to start
(exit code 1, one log line naming the invalid keys but never their values) if parsing fails.

| Variable | Type / format | Default | Secret | Purpose |
|---|---|---|---|---|
| `NODE_ENV` | `development` \| `test` \| `production` | `development` | no | enables dev-only behaviour (debug logs, boot-time policy check) |
| `PORT` | int 1..65535 | `3000` | no | public listener |
| `INTERNAL_PORT` | int 1..65535, ≠ `PORT` | `3100` | no | internal listener |
| `INTERNAL_HOST` | IP address | `127.0.0.1` | no | interface the internal listener binds to (private interface in deployment) |
| `DATABASE_URL` | `postgres://` URL | — | yes | identity database |
| `DATABASE_POOL_MAX` | int ≥ 1 | `10` | no | Knex pool size per process |
| `REDIS_URL` | `redis://` or `rediss://` URL | — | yes | rate limits, idempotency |
| `JWT_PRIVATE_KEYS` | JSON array of `{ kid, privateJwk }` (Ed25519 OKP), ≥ 1 entry, unique `kid` | — | yes | signing key set; public halves published as JWKS |
| `JWT_ACTIVE_KID` | string, must match a `kid` in `JWT_PRIVATE_KEYS` | — | no | key used to sign new tokens |
| `JWT_ISSUER` | string | `vcare-identity` | no | `iss` claim |
| `ACCESS_TOKEN_TTL_SECONDS` | int | `900` | no | user access token lifetime |
| `REFRESH_TOKEN_TTL_DAYS` | int | `30` | no | refresh token lifetime and cookie `Max-Age` |
| `SERVICE_TOKEN_TTL_SECONDS` | int | `300` | no | service token lifetime |
| `CORS_ORIGINS` | comma-separated list of origins (`https://…`) | — | no | CORS allowlist; credentials only for these |
| `APP_BASE_URL` | URL | — | no | base for links in verification and reset emails |
| `EMAIL_PROVIDER_API_KEY` | string | — | yes | email provider credential |
| `EMAIL_PROVIDER_FROM` | email address | — | no | sender address |
| `EMAIL_PROVIDER_BASE_URL` | URL | — | no | provider API endpoint |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` | `info` | no | `debug` rejected when `NODE_ENV=production` |
| `SHUTDOWN_TIMEOUT_MS` | int | `10000` | no | graceful shutdown deadline |

Time arithmetic from these values uses `pkg/utils/time.ts` (`addTime`, `toMs`) — never inline math.

## 2. Logging
Custom structured JSON `Logger`, one line per event, to stdout.

| Field | Always | Notes |
|---|---|---|
| `level` | yes | `debug` (dev only), `info`, `warn`, `error` |
| `message` | yes | no emojis |
| `timestamp` | yes | ISO-8601 UTC |
| `service` | yes | `identity-service` |
| `requestId` | on request paths | from `lib/request-id` |
| `userId` | when a user token is verified | numeric id only |
| `clientId` | when a service token is verified | `client_id` |
| `route` | on request completion | route pattern (`/api/users/:id`), not the raw URL |
| `status` | on request completion | HTTP status |
| `durationMs` | on request completion | |

**Never logged:** passwords, password hashes, access/refresh/reset/verification tokens, client secrets,
`Authorization` and `Cookie` headers, email addresses, phone numbers, full names, request bodies of
`/auth/*`. The logger redacts keys by name as defence in depth (`password`, `newPassword`,
`currentPassword`, `passwordHash`, `token`, `accessToken`, `refreshToken`, `access_token`,
`client_secret`, `clientSecret`, `authorization`, `cookie`, `set-cookie`, `email`, `phone`, `fullName`) —
callers still must not pass them. Error stacks are logged server-side only.

Security-relevant events logged at `warn` with a stable `message` (used by alerts): `refresh_token_reuse_detected`,
`login_failed`, `service_token_denied`, `rate_limited`, `status_changed` (info).

## 3. Error envelope
`lib/error/errorHandler.ts` is the **only** producer of error responses:

```json
{ "success": false, "error": { "code": "ValidationFailed", "message": "Request validation failed", "details": [{ "field": "email", "issue": "must be an email" }], "requestId": "7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b" } }
```

- Services throw `AppError` instances from `errors.ts` (stable `code`, HTTP status, message).
- `class-validator` failures become `400 ValidationFailed` with one `details` entry per failing field.
- Unknown errors become `500 InternalError`; the body never contains a stack, SQL, or internal message.
- The same envelope is used byte-for-byte by care-service. Codes: [api.md](./api.md) → Error code catalogue.

## 4. Request id
`lib/request-id` accepts an incoming `X-Request-Id` only if it is a UUID; otherwise generates a UUID v4.
It sets `req.requestId`, echoes the header on every response (including errors and health), binds it to
every log line, and it is stored on `user_status_changes.request_id`. Care forwards its request id on
internal calls, so one id spans both services.

## 5. Health checks
| Endpoint | Listener | Checks | 200 | 503 |
|---|---|---|---|---|
| `GET /api/health` | public | `SELECT 1` on the pool; Redis `PING`; each with a 500 ms timeout | `{ "status": "ok", "checks": { "database": "up", "redis": "up" } }` | `{ "status": "degraded", "checks": { … "down" } }` |
| `GET /internal/health` | internal | same | same | same |

Health responses are bare objects (not enveloped), carry `X-Request-Id`, require no token, and are not
rate-limited. During shutdown both return 503 so load balancers drain the instance.

## 6. Graceful shutdown (`src/server.ts`)
On `SIGTERM` / `SIGINT`:
1. Mark not-ready: health endpoints return 503.
2. Stop accepting new connections on **both** listeners (`server.close()`); in-flight requests continue.
3. Wait for in-flight requests (including open transactions) up to `SHUTDOWN_TIMEOUT_MS`.
4. Flush pending email jobs to the queue (never send synchronously during shutdown).
5. Destroy the Knex pool, quit Redis.
6. Exit 0; if the deadline passes, log `error` with the count of unfinished requests and exit 1.

Uncaught exceptions and unhandled rejections log at `error` and trigger the same shutdown.

## 7. Rate limiting (`lib/rate-limit`, Redis sliding window)
| Limiter | Route | Key subject | Limit | Window |
|---|---|---|---|---|
| `login-ip-email` | `POST /api/auth/login` | IP + sha256(lower(email)) | 5 | 1 min |
| `login-ip` | `POST /api/auth/login` | IP | 20 | 1 min |
| `register-ip` | `POST /api/auth/register` | IP | 5 | 1 h |
| `forgot-email` | `POST /api/auth/forgot-password` | sha256(lower(email)) | 3 | 1 h |
| `resend-email` | `POST /api/auth/resend-verification` | sha256(lower(email)) | 3 | 1 h |
| `reset-ip` | `POST /api/auth/reset-password` | IP | 10 | 1 h |
| `verify-ip` | `POST /api/auth/verify-email` | IP | 10 | 1 h |
| `refresh-family` | `POST /api/auth/refresh` | `family_id` | 30 | 1 min |
| `service-token-client` | `POST /internal/auth/token` | `client_id` | 60 | 1 min |

- Email subjects are hashed so Redis keys hold no PII.
- A tripped limiter returns `429 RateLimited` with `Retry-After` (seconds) and logs `rate_limited` at `warn`.
- Client IP comes from the socket, or from `X-Forwarded-For` only when the request arrives from the
  configured trusted proxy (Express `trust proxy` set to the ingress hop count).
- **Redis unavailable:** limiters on credential routes (login, register, forgot, resend, reset, verify,
  token) **fail closed** with `500 InternalError`; the refresh limiter fails open (the refresh token itself
  is the protection) so a Redis outage does not log everyone out. Idempotency on register fails closed.

## 8. Database connection
- Knex over `pg`, pool size `DATABASE_POOL_MAX`; each new connection runs `SET TIME ZONE 'UTC'`.
- Statement timeout 2 s on request paths; migrations run separately (`npm run migrate`) with no timeout.
- Hot-path queries are `EXPLAIN`ed before merge (CLAUDE.md → Performance rules).

## 9. Security headers and CORS
- `helmet` defaults on both listeners; HSTS enabled in production.
- CORS on the public listener only, allowlist `CORS_ORIGINS`, `credentials: true` only for listed origins;
  the internal listener sends no CORS headers.
- `Cache-Control: no-store` on every `/api/auth/*` response.

## 10. Background work
Outside any request: email delivery (via the `lib/email` port, retried with backoff by the provider
adapter's queue) and purge of expired/revoked token rows past retention. Neither may block or fail a
request.
