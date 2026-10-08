---
title: Identity Service — Quickstart
owner: identity-team
service: identity-service
status: draft
diataxis: tutorial
last_verified: 2026-10-08
tags: [tutorial, getting-started, local-dev, curl, docker, tests]
related: [infrastructure, api, auth-tokens, design-baseline, foundation-spec, foundation-manual-qa, service-auth-spec, service-auth-manual-qa, runbook]
---

# Quickstart (tutorial)

From zero to a running service with healthy listeners (sections 1–3, **works today**), then, once the auth
modules exist, to a logged-in user with a refreshed session (sections 4–5, **planned**).

> **Status (2026-09-16):** the `foundation` module is built — tooling, Docker, both listeners, health probes,
> migrations, the worker loop, and the test suites. No business endpoint exists yet, so sections 4–5 still show
> the intended shape from the contract; commands and variables marked `(planned)` do not exist yet. `.env` gains
> `OTP_PEPPER` with the registration module.

## 1. Prerequisites
- Node.js 24 LTS (`engines: >=24 <25`)
- Docker with Compose (for PostgreSQL 17 and Redis 7), or your own PostgreSQL 17 with the `citext` extension
  available and Redis 7
- `curl`, and `uuidgen` (or any UUID generator)

## 2. Configure
```bash
npm install
cp .env.example .env
```
`.env.example` holds synthetic values only. The variables the service reads today (full list with types and defaults:
[architecture/infrastructure.md](./architecture/infrastructure.md) → Environment variables):
```bash
NODE_ENV=development
PORT=3000
INTERNAL_PORT=3100
INTERNAL_HOST=127.0.0.1
TRUST_PROXY_HOPS=0
INTERNAL_TRUST_PROXY_HOPS=0
DATABASE_URL=postgres://identity:identity@localhost:5432/vcare_identity
DATABASE_POOL_MAX=10
REDIS_URL=redis://localhost:6379
CORS_ORIGINS=http://localhost:5173
LOG_LEVEL=info
SHUTDOWN_TIMEOUT_MS=10000
RATE_LIMIT_FALLBACK_DIVISOR=2
WORKER_POLL_INTERVAL_MS=1000
```
Only `DATABASE_URL` and `REDIS_URL` are required; the rest have defaults. If a variable is invalid, the process exits
with code 1 and logs `invalid_environment` with the offending keys (never their values).

Added by the auth and outbox modules `(planned)`, synthetic values only:
```bash
# JWT_PRIVATE_KEYS is set by the keygen step below: a JSON array of {"kid", "privateJwk"} (Ed25519). Never commit it.
JWT_PRIVATE_KEYS=
JWT_ACTIVE_KID=local-dev-1
ACCESS_TOKEN_TTL_SECONDS=900
REFRESH_TOKEN_TTL_DAYS=30
APP_BASE_URL=http://localhost:5173
EMAIL_PROVIDER_API_KEY=local-dev-not-sent
EMAIL_PROVIDER_FROM=no-reply@example.test
EMAIL_PROVIDER_BASE_URL=http://localhost:8025
```
Generate a local signing key (never reuse it anywhere else):
```bash
npm run keys:generate -- --kid local-dev-1   # (planned) prints the JWT_PRIVATE_KEYS entry
```
In development the email adapter `(planned)` writes messages to the log-safe local mail catcher at
`EMAIL_PROVIDER_BASE_URL` instead of sending them; open it to read registration codes and reset links.

## 3. Start dependencies, migrate, run
Start PostgreSQL 17 (host port 5432, database `vcare_identity`) and Redis 7 (host port 6379):
```bash
docker compose up -d postgres redis
```
Apply migrations (today: the `citext` extension), then start the API and, in a second terminal, the worker:
```bash
npm run migrate          # also: npm run migrate:status, npm run migrate:rollback
npm run dev              # public listener :3000, internal listener :3100 (tsx watch)
npm run dev:worker       # worker loop; job handlers arrive with the outbox module
```
Alternative: build the image and run the whole stack (postgres, redis, migrate, api, worker) in Docker with
`docker compose up -d --build`. Care's stack uses host ports 5433/6380/3001/3101, so both run side by side.

Check both listeners:
```bash
curl -s http://localhost:3000/api/health/live
curl -s http://localhost:3000/api/health/ready
curl -s http://localhost:3100/internal/health/ready
```
Expect `{"status":"ok"}` from liveness and `{"status":"ok","checks":{"database":"up","redis":"up"}}` from each
readiness probe. Stop Redis (`docker compose stop redis`) and readiness answers `200` with `"status":"degraded"`;
stop Postgres and it answers `503` with `"status":"down"`. Liveness stays `200` either way. Start them again with
`docker compose start redis postgres`.

### Run the checks and tests
```bash
npm run lint
npm run typecheck
npm test                                                      # unit suites, no infrastructure
docker compose -f docker-compose.test.yml up -d --wait        # test Postgres on 5435, Redis on 6382
npm run test:integration                                      # real Postgres + Redis
docker compose -f docker-compose.test.yml run --rm test       # hermetic: lint, typecheck, unit, integration (what CI runs)
docker compose -f docker-compose.test.yml down -v
```
The CURL walkthrough of every foundation behaviour is [foundation/manual-qa.md](./foundation/manual-qa.md), and
its repeatable form is `scripts/curl-test-foundation.sh` (set `PUBLIC_URL` / `INTERNAL_URL` to your listeners).

## 4. Walk the auth flow (planned)
Set up a cookie jar (the refresh token lives only in the `vcare_rt` cookie) and a helper for request ids:
```bash
JAR=$(mktemp)
rid() { uuidgen | tr 'A-Z' 'a-z'; }
```

### 4.1 Start registration
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/auth/register/start \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: $(rid)" \
  -d '{"email":"sara.patient@example.test"}'
```
Expect `202` — the same answer whether or not the email is already registered. With the worker running, open the
local mail catcher and copy the 6-digit code (valid 10 minutes, 5 attempts). Running it again sends a new code.

### 4.2 Complete registration
`Idempotency-Key` is required here. Re-running the same command with the same key replays the response.
```bash
IDEM=$(rid)
curl -s -X POST http://localhost:3000/api/auth/register/complete \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: $(rid)" \
  -H "Idempotency-Key: $IDEM" \
  -d '{"email":"sara.patient@example.test","code":"<6-digit code>","password":"correct-horse-battery-9","fullName":"Sara Patient","role":"patient","timezone":"Africa/Cairo","locale":"en-EG"}'
```
Expect `201` with `data.status = "active"` and `data.emailVerifiedAt` set. A wrong code is
`400 ValidationFailed` (`field: code`). Try the same key with a different body — expect `422 IdempotencyConflict`.

### 4.3 Log in
```bash
curl -s -c "$JAR" -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: $(rid)" \
  -d '{"email":"sara.patient@example.test","password":"correct-horse-battery-9"}'
```
Expect `200` with `data.accessToken`, `data.tokenType = "Bearer"`, `data.expiresIn = 900`, and `data.user`.
The response sets `vcare_rt` (HttpOnly, `Path=/api/auth`) into `$JAR`. Save the access token:
```bash
ACCESS=<paste data.accessToken>
```
A wrong password returns `401 InvalidCredentials` — the same response as an unknown email.

### 4.4 Call `/api/auth/me`
```bash
curl -s http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer $ACCESS" \
  -H "X-Request-Id: $(rid)" -i
```
Expect `200`, `X-Request-Id` echoed, `Cache-Control: no-store`, and your account with `emailVerifiedAt` set.

### 4.5 Refresh
```bash
curl -s -b "$JAR" -c "$JAR" -X POST http://localhost:3000/api/auth/refresh \
  -H "X-Request-Id: $(rid)"
```
Expect `200` with a new `accessToken`; the jar now holds a **rotated** `vcare_rt`.

See reuse detection: save the cookie before refreshing, refresh, then replay the old cookie.
```bash
cp "$JAR" "$JAR.old"
curl -s -b "$JAR" -c "$JAR" -X POST http://localhost:3000/api/auth/refresh -H "X-Request-Id: $(rid)" > /dev/null
curl -s -b "$JAR.old" -X POST http://localhost:3000/api/auth/refresh -H "X-Request-Id: $(rid)"
```
Expect `401 RefreshTokenReused` — and the whole family is revoked, so the current cookie in `$JAR` now
fails with `401 RefreshTokenInvalid`. Log in again to continue.

### 4.6 Log out
```bash
curl -s -o /dev/null -w "%{http_code}\n" -b "$JAR" -c "$JAR" -X POST http://localhost:3000/api/auth/logout \
  -H "X-Request-Id: $(rid)"
```
Expect `204` and a cleared cookie. The access token still works until it expires (at most 15 minutes).

## 5. Try the internal API (optional)
The token exchange (module `service-auth`) works today; the guarded `/internal/users` routes arrive with the
`internal-users` module and answer `404` until then.

Seed a local service client (local development only: the script refuses `NODE_ENV=production`, reads `DATABASE_URL`
from `.env`, and upserts the live row, replacing its secret). Every argument is optional; the defaults are
`--client-id care-service --name "Care service (local)" --scopes "users:read users:status:write" --audiences vcare-identity`:
```bash
npm run seed:service-client
# prints client_id=care-service and a fresh client_secret=<secret>, once. Run it again to get a new secret.
```
Then exchange credentials on the internal listener (JSON or `application/x-www-form-urlencoded`):
```bash
curl -s -X POST http://localhost:3100/internal/auth/token \
  -H "Content-Type: application/json" -H "X-Request-Id: $(rid)" \
  -d '{"grant_type":"client_credentials","client_id":"care-service","client_secret":"<printed secret>","scope":"users:read","audience":"vcare-identity"}'
```
Expect `200` with `data.access_token`, `token_type: "Bearer"`, `expires_in: 300` and `scope: "users:read"`, plus
`Cache-Control: no-store`. A wrong secret is `401 InvalidCredentials`; a scope or audience the client may not have is
`403 InsufficientScope`. The limits are 30/min per IP and 60/min per `client_id`. Decode the token to see
`typ: "service"` and a single-string `aud`. For a non-local client use the print-SQL procedure in the
[runbook](./runbook.md) → Provision a service client.

Once `internal-users` exists, call `GET http://localhost:3100/internal/users?ids=1,2,3` with
`Authorization: Bearer $SVC`, and send your **user** token to the same route to see `401 ServiceTokenRequired`. The
repeatable CURL walkthrough for the token exchange is [service-auth/manual-qa.md](./service-auth/manual-qa.md)
(`scripts/curl-test-service-auth.sh`).

## Next
- Every endpoint, role, and error code → [architecture/api.md](./architecture/api.md) and
  [contracts/openapi.yaml](../contracts/openapi.yaml)
- How tokens work → [architecture/auth-tokens.md](./architecture/auth-tokens.md)
- Env and operations → [architecture/infrastructure.md](./architecture/infrastructure.md), [runbook.md](./runbook.md)

## Migration names changed (2026-10-04)

Migrations are now recorded without a file extension so `node dist/migrate.js` and `npm run migrate` share one
`knex_migrations` table. A dev database migrated earlier needs this one-time fix (production has none yet):

```sql
UPDATE knex_migrations SET name = regexp_replace(name, '\.(ts|js)$', '');
```

The dev compose stack reads `JWT_PRIVATE_KEYS` from your untracked `.env` (`npm run keys:generate`) and binds all
ports to `127.0.0.1`.
