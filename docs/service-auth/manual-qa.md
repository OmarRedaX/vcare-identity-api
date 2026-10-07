---
title: service-auth — Manual QA (CURL)
owner: identity-team
service: identity-service
module: service-auth
status: current
diataxis: how-to
last_verified: 2026-10-07
tags: [manual-qa, curl, service-auth, client-credentials, service-guard, internal-listener, rate-limit, provisioning]
related: [service-auth-spec, service-auth-tasks, service-auth, users-manual-qa, adr-0010-manual-admin-provisioning-role-policies, adr-0014-health-liveness-readiness-split]
---

# service-auth — Manual QA (CURL)

_Run: 2026-10-07 • Server: public http://localhost:3000, internal http://localhost:3100 • Result: 217 pass / 0 fail (final run on a fresh server and fresh Redis; two earlier runs only found defects in the QA script itself)_

Repeatable form: `scripts/curl-test-service-auth.sh` (`PUBLIC_URL`, `INTERNAL_URL`, `DATABASE_URL`, `SERVER_LOG`, `REDIS_DB` env; needs bash,
curl, python, psql, node + `npx tsx`; about 6 minutes because of the rate-limit sections).

## Environment
Local `tsx src/server.ts` against the host PostgreSQL 18 database `vcare_identity_test` (role `identity`; 9 migrations applied,
`20261007000300_create_service_clients` among them, none pending) and host Redis database 2 (flushed before each run). A throwaway
Ed25519 key (`JWT_PRIVATE_KEYS`/`JWT_ACTIVE_KID`) and `OTP_PEPPER` were generated for the run; `NODE_ENV=development`,
`INTERNAL_TRUST_PROXY_HOPS=1` (so each request can carry its own `X-Forwarded-For`; see N-3), `HASH_CONCURRENCY=2`, `LOG_LEVEL=info`.
The server's stdout/stderr was captured to a file and grepped at the end (section "Server log").

Fixtures: every service client was created by `scripts/provision-service-client.ts` (SQL applied with `psql -f`) except `care-service`,
which came from `scripts/seed-service-client.ts`; client ids are unique per run (`qa-...-<run>`). Patient, doctor and admin users are SQL
inserts (`@example.test`) and their tokens come from `POST /api/auth/login`. Secrets, hashes and tokens are never printed or recorded here.

## Cases
| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 001-002 | - | preflight | - | internal listener up; migration `20261007000300` applied | up | up | pass |
| 003-014 | CLI | `provision-service-client.ts` | ops | arg validation: no args, bad client id / unknown scope / bad audience (values not echoed), missing name, unknown flag, positional, `--leaked` without `--rotate`, overlap 0 / 169 / abc / with `--leaked` | exit 1, message names the argument only | as expected | pass |
| 015-025 | CLI | `provision-service-client.ts` | ops | new client: exit 0; stderr = banner + 43-char base64url secret + rule; stdout = one `INSERT` with an argon2id hash and no secret (BR-24); `psql -f` applies; row active with 2 scopes and 1 audience; applying twice refused by `uq_service_clients_client_id` | as listed | as listed | pass |
| 026-040 | POST | `/internal/auth/token` | service | JSON success: `200`, `no-store`, `token_type=Bearer`, `expires_in=300`, scope echo, data keys exactly 4, no `Set-Cookie`, `X-Request-Id` echoed, JSON content type | 200 | 200 | pass |
| 041-052 | POST | `/internal/auth/token` | service | the issued JWT verified against `/.well-known/jwks.json` (EdDSA, `kid`, JWKS has no `d`); claims `iss, sub=client_id, typ=service, aud` (single string), `scope`, `exp-iat=300`, `jti`; claim set exactly `aud,exp,iat,iss,jti,scope,sub,typ` | BR-7 | BR-7 | pass |
| 053-058 | POST | `/internal/auth/token` | service | form body (`application/x-www-form-urlencoded`, also with `; charset=UTF-8`); subset scope; duplicate scopes de-duplicated in first-seen order; request order kept; `Idempotency-Key` ignored (two different tokens) | 200 | 200 | pass |
| 059-070 | POST | `/internal/auth/token` | any | `401 InvalidCredentials` for unknown client, wrong secret, disabled client, soft-deleted client; bodies identical minus `requestId`; generic message; wrong secret plus bad scope/audience and unknown client plus bad scope stay `401` | 401 | 401 | pass |
| 071 | POST | `/internal/auth/token` | any | timing sample, one argon2id verify on each path: unknown 0.253 s, wrong secret 0.259 s, disabled 0.256 s (wall time incl. curl) | indistinguishable | indistinguishable | pass |
| 072-076 | POST | `/internal/auth/token` | service | `403 InsufficientScope`: scope not allowed (`doctors:read`), unknown `foo:bar`, allowed + disallowed mix, audience `vcare-care`; message reveals no allow-list | 403 | 403 | pass |
| 077-098 | POST | `/internal/auth/token` | any | `400 ValidationFailed`: grant_type wrong / missing; client_id bad pattern / short / non-string; secret < 32 / > 256; scope empty / uppercase / double space / no colon / > 256 / array; audience bad pattern / > 64; extra property; malformed JSON; empty body; JSON array; `text/plain`; form repeated key; form missing secret; `details[0]` has `field`,`issue`; submitted secret not echoed; `no-store` | 400 | 400 | pass |
| 099-102 | GET, PUT, POST | `/internal/auth/token`, `/internal/auth/tokens`, `/internal/users` | any | wrong method is 404 or 405 not 5xx; unknown internal path and the not-yet-built `/internal/users` are `404 NotFound` | 404/405 | 404 | pass |
| 103-105 | POST | `/internal/auth/token` | any | `X-Request-Id`: valid id echoed; invalid replaced by a UUID; absent generated | echoed/generated | as expected | pass |
| 106-111 | POST | `/internal/auth/token` | service | `last_used_at`: null, set after first success, unmoved by 2nd success and by a failed exchange, advances after the row is aged 2 minutes (BR-20) | as listed | as listed | pass |
| 112-131 | CLI + POST | `provision --rotate [--overlap-hours 1 / --leaked]` | ops | rotation SQL is one `UPDATE` (previous hash, `interval '1 hours'`, `deleted_at IS NULL`, no plaintext); overlap: new and old secrets both `200`, random `401`; after `previous_secret_expires_at` passes old `401`, new `200`; `--leaked` clears `previous_*` (pair CHECK holds), newest `200`, previous and oldest `401`; rotate of an unknown client prints `UPDATE 0` | as listed | as listed | pass |
| 132-134 | CLI + POST | provision on a soft-deleted `client_id` | ops | `INSERT` succeeds (BR-22), new secret `200`, old row's secret `401` | as listed | as listed | pass |
| 135-149 | CLI + POST | `seed-service-client.ts` | dev | default `care-service`; stdout only `client_id=`,`client_secret=`; stderr empty; default scopes and audience stored; hash argon2id, not the secret; token exchange works; re-run upserts a fresh secret (one live row, old secret `401`); `NODE_ENV=production` exits 1 with no secret; bad scope names `--scopes` not the value; missing `DATABASE_URL` exits 1 | as listed | as listed | pass |
| 150-157 | POST | `/internal/auth/token` | any | `token-ip` 30/min: requests 1-30 `401`, request 31 is `429 RateLimited` with whole-second `Retry-After`, `no-store`, `success=false`; another IP unaffected | 429 at #31 | 429 at #31 | pass |
| 158-165 | POST | `/internal/auth/token` | any | `token-client` 60/min with distinct IPs: 60 wrong-secret `401`, request 61 with the CORRECT secret is `429` (limiter before hashing), `Retry-After`, `no-store`, no token in body; another client unaffected | 429 at #61 | 429 at #61 | pass |
| 166-167 | POST | `/internal/auth/token` | any | garbage `client_id` values share the `invalid` bucket: a `429` appears within 61 requests; no `BAD_*` keys in Redis | bounded | bounded | pass |
| 168-176 | GET | `/internal/health/live`, `/ready`, `/api/health/live` | none | live `200 {"status":"ok"}` bare; ready `200` with `checks.database=up`, `checks.redis` reported, no envelope; both `no-store` and echo `X-Request-Id`; open even with a garbage bearer | 200 | 200 | pass |
| 177-182 | POST, GET | public `:3000` `/internal/*` and `/api/auth/token`; internal `:3100` `/api/auth/me` | any | `/internal/auth/token`, `/internal/health/live`, `/internal/health/ready`, `/internal/users` on the public port; `/api/auth/token`; `/api/auth/me` on the internal port | 404 NotFound | 404 NotFound | pass |
| 183-194 | POST, GET | `/internal/auth/token`, `/internal/users` | patient, doctor, admin | user bearer is ignored on the token route (credentials decide, `200`); user bearer without credentials is `400` not a free pass; `/internal/users` with each user token is `404` (route absent, see N-1); spoofed `X-User-Id`/`X-Role`/`X-Forwarded-User` change nothing | as listed | as listed | pass |
| 195-199 | GET, PATCH | `/api/users`, `/api/auth/me`, `/api/users/1/sessions` | service | service token (and the token of a since-disabled client) on public routes | 401 Unauthorized | 401 Unauthorized | pass |
| 200-202 | env | `NODE_ENV=production tsx src/server.ts` | - | hops=0 reports `INTERNAL_TRUST_PROXY_HOPS` invalid, hops=1 does not; no listener started (BR-23) | as listed | as listed | pass |
| 203 | - | all | - | every response echoed `X-Request-Id` (250 of 250) | echoed | echoed | pass |
| 204-221 | - | server log | - | see below | clean | clean | pass |

Case numbers are approximate groupings of the script's 217 numbered checks (`scripts/curl-test-service-auth.sh` prints each one).

### Server log (captured this time and grepped)
The whole run's stdout/stderr (about 255 `request_completed`, 119 `metric`, 110 `service_token_denied`, 26 `service_token_issued`, 9 `rate_limited`,
3 `login_succeeded`) was checked against every plaintext client secret (generated, rotated and seeded), every issued access token, and the
argon2id hashes read from the printed SQL, plus pattern greps. Result: none of them appears; no `argon2id$`, `client_secret`,
`access_token`, `Authorization`/`Bearer`, `@example.test` or JWT-shaped string; every line is a JSON object; no `error`-level line.
`service_token_issued` lines all carry `requestId`, `clientId`, `audience`, `scope`. `service_token_denied` was logged with reasons
`unknown_client`, `inactive`, `bad_secret`, `scope`, `audience` (reasons `secret_expired` are logged as `bad_secret` or not distinguished
by this run; not asserted).

### Extra check outside the script
With `INTERNAL_TRUST_PROXY_HOPS=0` (server restarted) the `X-Forwarded-For` header is ignored: 32 requests with 32 different forwarded IPs
returned thirty `401` then `429 429`, i.e. all callers share the proxy-less peer address (the BR-23 reason for the production refinement).

## Failures / notes
- No contract or spec failures; no 500 observed.
- **N-1 (what is reachable):** the module ships no guarded production route, and the probe router is test-only. Through the real
  listeners this run could not exercise `serviceGuard` or the `service` policy (user token on a guarded route, wrong `aud`, expired token,
  missing scope, `alg: none`, tampered signature, unknown `kid`). Those are covered by `tests/unit/lib/auth/service-guard.test.ts`,
  `tests/unit/lib/rbac/authorize-service.test.ts` and `tests/integration/service-auth/`. What was proven by CURL: user tokens of all three
  roles and a service token are each refused or ignored where they do not belong (the table above), and `/internal/users` is `404` until the
  `internal-users` module exists. Re-run the guarded-route cases against the real routes in `/manual-qa internal-users`.
- **N-2 (not exercised by CURL):** Redis-down fallback limiter (`degrade: "fallback"`, readiness `degraded`), `HASH_QUEUE_MAX` saturation
  (`429`), Postgres-down `503` readiness and the token route's `500` envelope. The process does not control the host Redis/PostgreSQL
  services; these are covered by integration and unit tests. The `secret_expired` denial reason is not asserted separately in the log
  check (the expired-previous-secret case itself passed).
- **N-3 (QA setup):** the per-IP limiter (30/min) bounds a run that shares one source address. The script relies on
  `INTERNAL_TRUST_PROXY_HOPS=1` plus a random `X-Forwarded-For` per request; with hops 0 only about 30 token requests per minute are possible
  from a single host (verified above). The `invalid` bucket is shared with every body-less or malformed-`client_id` request, so the
  script runs that section last; a minute of garbage traffic from one source can make a legitimate caller with no `client_id` see `429`
  (accepted residual, spec 3.2).
- **N-4 (observation, informational):** token-endpoint wall time was about 0.25 s per request (curl process start included) with
  `HASH_CONCURRENCY=2`; the three failure paths were indistinguishable (0.253/0.259/0.256 s). A server-side latency measure is the right
  tool for the p95 < 250 ms budget; not measured here.
- **N-5 (observation):** `--rotate` for an unknown `--client-id` prints a valid `UPDATE` that touches 0 rows (`UPDATE 0`); the script
  cannot know, and the runbook should say to check the `UPDATE n` count. Not a defect against the spec.
- **N-6 (observation):** the readiness values are `up`/`down` per check (`{"status":"ok","checks":{"database":"up","redis":"up"}}`),
  matching the foundation module; the spec's `ok|degraded|down` applies to `status`.
- The QA database keeps the rows created by the run (`qa-*` clients, `qa-sa-*@example.test` users, and `care-service` from the seed script).
