---
title: Identity Service — Quickstart
owner: identity-team
service: identity-service
status: draft
diataxis: tutorial
last_verified: 2026-09-14
tags: [tutorial, getting-started, local-dev, curl]
related: [infrastructure, api, auth-tokens]
---

# Quickstart (tutorial)

From zero to a logged-in user with a refreshed session, on your machine.

> No application code exists yet. Every command marked `(planned)` shows the intended shape once the
> modules are built through the workflow. The curl requests follow `contracts/openapi.yaml` exactly.

## 1. Prerequisites
- Node.js 24 LTS
- PostgreSQL 16 with the `citext` extension available
- Redis 7
- `curl`, and `uuidgen` (or any UUID generator)

## 2. Configure
```bash
cp .env.example .env    # (planned)
```
Minimum `.env` for local development (synthetic values only):
```bash
NODE_ENV=development
PORT=3000
INTERNAL_PORT=3100
INTERNAL_HOST=127.0.0.1
DATABASE_URL=postgres://identity:identity@localhost:5432/vcare_identity
REDIS_URL=redis://localhost:6379
# JWT_PRIVATE_KEYS is set by the keygen step below: a JSON array of {"kid", "privateJwk"} (Ed25519). Never commit it.
JWT_PRIVATE_KEYS=
JWT_ACTIVE_KID=local-dev-1
ACCESS_TOKEN_TTL_SECONDS=900
REFRESH_TOKEN_TTL_DAYS=30
SERVICE_TOKEN_TTL_SECONDS=300
CORS_ORIGINS=http://localhost:5173
APP_BASE_URL=http://localhost:5173
EMAIL_PROVIDER_API_KEY=local-dev-not-sent
EMAIL_PROVIDER_FROM=no-reply@example.test
EMAIL_PROVIDER_BASE_URL=http://localhost:8025
```
Generate a local signing key (never reuse it anywhere else):
```bash
npm run keys:generate -- --kid local-dev-1   # (planned) prints the JWT_PRIVATE_KEYS entry
```
In development the email adapter writes messages to the log-safe local mail catcher at
`EMAIL_PROVIDER_BASE_URL` instead of sending them; open it to read verification links.

## 3. Install, migrate, run
```bash
npm install          # (planned)
npm run migrate      # (planned) creates citext + identity tables
npm run dev          # (planned) public listener :3000, internal listener :3100
```
Check both listeners:
```bash
curl -s http://localhost:3000/api/health
curl -s http://localhost:3100/internal/health
```
Expect `{"status":"ok","checks":{"database":"up","redis":"up"}}` from each.

## 4. Walk the auth flow
Set up a cookie jar (the refresh token lives only in the `vcare_rt` cookie) and a helper for request ids:
```bash
JAR=$(mktemp)
rid() { uuidgen | tr 'A-Z' 'a-z'; }
```

### 4.1 Register a patient
`Idempotency-Key` is required here. Re-running the same command with the same key replays the response.
```bash
IDEM=$(rid)
curl -s -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: $(rid)" \
  -H "Idempotency-Key: $IDEM" \
  -d '{"email":"sara.patient@example.test","password":"correct-horse-battery-9","fullName":"Sara Patient","role":"patient","timezone":"Africa/Cairo","locale":"en-EG"}'
```
Expect `201` with `data.status = "active"` and `data.emailVerifiedAt = null`.
Try the same key with a different body — expect `422 IdempotencyConflict`.

### 4.2 Verify the email
Open the verification email in the local mail catcher and copy the `token` from the link, then:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/auth/verify-email \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: $(rid)" \
  -d '{"token":"<token from the email link>"}'
```
Expect `204`. Running it again is also `204` (no-op).

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
Seed a local service client, then exchange credentials on the internal listener:
```bash
npm run seed:service-client -- --client-id care-service --scopes "users:read users:status:write" --audiences vcare-identity   # (planned) prints a one-time secret
curl -s -X POST http://localhost:3100/internal/auth/token \
  -H "Content-Type: application/json" -H "X-Request-Id: $(rid)" \
  -d '{"grant_type":"client_credentials","client_id":"care-service","client_secret":"<printed secret>","scope":"users:read","audience":"vcare-identity"}'
SVC=<paste data.access_token>
curl -s "http://localhost:3100/internal/users?ids=1,2,3" -H "Authorization: Bearer $SVC" -H "X-Request-Id: $(rid)"
```
Now send your **user** token to the same route — expect `401 ServiceTokenRequired`.

## Next
- Every endpoint, role, and error code → [architecture/api.md](./architecture/api.md) and
  [contracts/openapi.yaml](../contracts/openapi.yaml)
- How tokens work → [architecture/auth-tokens.md](./architecture/auth-tokens.md)
- Env and operations → [architecture/infrastructure.md](./architecture/infrastructure.md), [runbook.md](./runbook.md)
