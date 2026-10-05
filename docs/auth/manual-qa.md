---
title: auth — Manual QA (CURL)
owner: identity-team
service: identity-service
module: auth
status: current
diataxis: how-to
last_verified: 2026-10-05
tags: [manual-qa, curl, auth, registration, login, refresh-token, jwks, password, rate-limit]
related: [auth-spec, auth-tasks, foundation-manual-qa, adr-0005-refresh-reuse-grace-window, adr-0006-email-first-registration-otp, adr-0007-transactional-outbox-worker]
---

# auth — Manual QA (CURL)

_Run: 2026-10-04 • Server: http://localhost:3000 (public), compose project `vcare-identity-qa` • Result: 253 pass / 3 fail_

Repeat the run with `scripts/curl-test-auth.sh` (about 4.5 minutes, mostly docker-exec round trips and one 12 s grace-window
sleep). The script exits non-zero while any defect below is open. Numbers in the table are the script's check ids, so a
row maps one-to-one onto the printed `PASS`/`FAIL [nnn]` lines. Tokens, cookies, one-time codes and emails never appear in
the output or in this file (`<ACCESS_TOKEN>`, `<RT>`, `<CODE>`, `qa-<tag>-<run>@example.test`).

```bash
# stack already up (api :3000, internal :3100, worker with EMAIL_PROVIDER=capture)
./scripts/curl-test-auth.sh
BASE_URL=http://localhost:3000 COMPOSE_PROJECT=vcare-identity-qa RUN_LOG_SCAN=1 ./scripts/curl-test-auth.sh
```

## How the run works (fixtures)

| Concern | Handling |
|---|---|
| One-time codes | Read at runtime from the worker's capture file (`/tmp/mail/outbox.jsonl`, JSON lines `{to, subject, text}`) with `docker compose exec worker`; the script polls up to 30 s for a line addressed to the test email that is newer than a baseline count. No code is stored in the script or in this doc. |
| `suspended` and `rejected` accounts | No users/internal status endpoint exists yet, so the script sets state with `UPDATE users SET status=... WHERE email=...` through `docker compose exec postgres psql` (QA-only fixture). A rejected doctor is a doctor registered as `pending` and then set to `rejected` in SQL. |
| Expired codes and refresh tokens | Fixtures: `registration_challenges.expires_at` / `password_resets.expires_at` moved one minute into the past; a live `refresh_tokens` row aged to `created_at = now() - 40 d, expires_at = now() - 1 d`. |
| Duplicate-email 409 | A challenge is opened for a fresh email, an account with that email is inserted by SQL (fixture), then `register/complete` is called with the real code. |
| Rate-limit isolation | `X-Forwarded-For` is **not** honoured (`TRUST_PROXY_HOPS` defaults to 0, `src/lib/http/client-ip.ts` uses `req.ip`), so every call shares one client IP and the per-IP limits (register/start 5/h, register/complete 10/h, reset 10/h, login 20/min) are budgeted. The script runs `redis-cli FLUSHALL` before each group and runs the dedicated rate-limit group last. Throwaway stack only. |
| Cookies | `Secure` cookies are handled by hand (the script parses `Set-Cookie` and sends `Cookie: vcare_rt=...`) so that old tokens can be replayed on purpose. One case also uses a real curl cookie jar (`-c`/`-b`): curl 8.17 stores and resends the `Secure` cookie for `http://localhost`, so the jar works for localhost (checks 058-060). |
| Token inspection | The access token is split and only header and payload are decoded (python, no signature printed). |
| Expired access token | Not exercised, see "Not exercised". |

## Cases

All rows: `X-Request-Id` was echoed (valid UUID adopted; every one of the 259 helper calls matched, check 256). Unless the
row says otherwise, `Cache-Control: no-store` was present and `success` was `false` with the stated `error.code`.

| # (check ids) | Method | Path | Role | Scenario | Expected | Got | Result |
|---|---|---|---|---|---|---|---|
| 003-006 | POST | /api/auth/register/start | public | unknown email | 202, empty body, no-store, code mailed | 202, empty, no-store, 6-digit code captured | pass |
| 007-011 | POST | /api/auth/register/start | public | missing email, invalid email, unknown property, malformed JSON | 400 ValidationFailed (field email / role / body) | as expected, envelope has requestId | pass |
| 012-013 | POST | /api/auth/register/start | public | same Idempotency-Key twice | 202 twice, one challenge row | 202, 202, 1 row | pass |
| 032-035 | POST | /api/auth/register/start | public | known email | 202, body and headers identical to unknown email, no challenge row | identical (ignoring X-Request-Id, Date, ETag), 0 new rows | pass |
| 215-218 | POST | /api/auth/register/start | public | rate limit 3/h per email | 4th call 429 RateLimited | 4th call 429, Retry-After 3599 | pass |
| 219-222 | POST | /api/auth/register/start | public | rate limit 5/h per IP | 6th call 429 | 6th call 429, Retry-After 3598 | pass |
| 014-015 | POST | /api/auth/register/complete | public | missing / non-UUID Idempotency-Key | 400 ValidationFailed field Idempotency-Key | as expected | pass |
| 016-021 | POST | /api/auth/register/complete | public | malformed code, role admin, short password, denylisted password, invalid timezone, wrong code | 400 ValidationFailed on code / role / password / password / timezone / code | as expected | pass |
| 022-027 | POST | /api/auth/register/complete | public | patient success | 201, role patient, status active, ev true, no cookie, no secrets, numeric id | as expected | pass |
| 028-029 | POST | /api/auth/register/complete | public | replay same key + same body | original 201 and identical body | 201, identical body | pass |
| 030 | POST | /api/auth/register/complete | public | same key, different body | 422 IdempotencyConflict | 422 IdempotencyConflict | pass |
| 031 | POST | /api/auth/register/complete | public | consumed code, new key | 400 on code | 400 on code | pass |
| 036 | POST | /api/auth/register/complete | public | doctor success | 201 doctor / pending | 201 doctor / pending | pass |
| 040 | POST | /api/auth/register/complete | public | account created after the challenge opened | 409 Conflict | 409 Conflict | pass |
| 041-047 | POST | /api/auth/register/complete | public | 5 wrong codes, then the correct code | each 400 on code, correct code also 400, no account | as expected, 0 users | pass |
| 048 | POST | /api/auth/register/complete | public | expired code (fixture) | 400 on code | 400 on code | pass |
| 049-051 | POST | /api/auth/register/complete | public | two concurrent requests, same key and body | one 201, one 409 with Retry-After: 1 | 201 + 409, Retry-After 1, code Conflict | pass |
| 223-226 | POST | /api/auth/register/complete | public | rate limit 10/h per IP | 11th call 429 | 11th call 429, Retry-After 3599 | pass |
| 052-057 | POST | /api/auth/login | public | patient success | 200, accessToken, tokenType Bearer, expiresIn 900, user; vcare_rt cookie; no refresh token in body | as expected | pass |
| 055 | POST | /api/auth/login | public | cookie attributes | `vcare_rt=<RT>; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=2592000` | exact match | pass |
| 058-060 | POST | /api/auth/login, /api/auth/refresh | public | real curl cookie jar over http://localhost | jar stores and resends the cookie, token rotates | stored, refresh 200, value rotated | pass |
| 061-065 | POST | /api/auth/login | public | wrong password vs unknown email | both 401 InvalidCredentials, identical body and headers, no cookie | identical (ignoring X-Request-Id, Date, ETag) | pass |
| 066-068 | POST | /api/auth/login | public | invalid email, missing password, unknown property | 400 ValidationFailed | as expected | pass |
| 069-071 | POST | /api/auth/login | public | Idempotency-Key header sent twice | ignored: two fresh sessions, no replay | 200 + 200, different token and cookie | pass |
| 072-073 | POST | /api/auth/login | public | pending doctor, rejected doctor | 200, token status pending / rejected | as expected | pass |
| 075-077 | POST | /api/auth/login | public | suspended account | 403 AccountSuspended, no cookie; with a wrong password 401 (status not revealed) | as expected | pass |
| 207-210 | POST | /api/auth/login | public | rate limit 5/min per IP+email | 6th call 429 | 6th call 429, Retry-After 58 | pass |
| 211-214 | POST | /api/auth/login | public | rate limit 20/min per IP | 21st call 429 | 21st call 429, Retry-After 47 | pass |
| 078-086 | - | access token | - | decoded claims | alg EdDSA, kid, iss vcare-identity, aud [vcare-identity, vcare-care], sub string = id, typ user, role, status, ev, jti UUID, exp-iat 900, no extra claims | as expected | pass |
| 087-091 | GET | /.well-known/jwks.json | public | JWKS | 200, bare `{keys:[...]}`, `public, max-age=300`, token kid present, no `d` | as expected | pass |
| 092-097 | POST | /api/auth/refresh | cookie | rotation | 200 new access token, cookie value differs, attributes ok, token not in body | as expected | pass |
| 098-100 | POST | /api/auth/refresh | cookie | replay within the 10 s grace window | 401 RefreshTokenInvalid, no Set-Cookie, successor still works (200) | as expected | pass |
| 101-105 | POST | /api/auth/refresh | cookie | replay after the grace window | 401 RefreshTokenReused with clearing Set-Cookie (`Max-Age=0`); newest token then 401 RefreshTokenInvalid | as expected | pass |
| 106-109 | POST | /api/auth/refresh | none / garbage | missing cookie, garbage cookie, unknown 43-char token | 401 RefreshTokenInvalid, clearing cookie | as expected | pass |
| 110 | POST | /api/auth/refresh | cookie | expired token (fixture) | 401 RefreshTokenInvalid | 401 RefreshTokenInvalid | pass |
| 111-112 | POST | /api/auth/refresh | cookie | rejected and pending accounts | 200, token carries the status | 200, rejected / pending | pass |
| 113-116 | POST | /api/auth/refresh | cookie | suspended account | 403 AccountSuspended, clearing cookie; replay 401; no live token left | as expected, 0 live rows | pass |
| 243-247 | POST | /api/auth/refresh | cookie | rate limit 30/min per family | 31st call 429, cookie untouched | 31st call 429, Retry-After 42, no Set-Cookie | pass |
| 117-125 | POST | /api/auth/logout | cookie | logout with cookie, again, no cookie, garbage cookie | 204, clearing cookie, refresh with the cookie then 401 | as expected | pass |
| 126-129 | GET | /api/auth/me | patient | success | 200, exactly the 12 User fields, no hash/token fields | as expected | pass |
| 130-134 | GET | /api/auth/me | - | no token, garbage token, tampered signature, `Basic` scheme, refresh token as bearer | 401 Unauthorized | as expected | pass |
| 135-137 | PATCH | /api/auth/me | patient | all five fields, then null phone/avatarUrl | 200, timezone/locale stored canonical (`Africa/Cairo`, `ar-EG`), nulls clear | as expected | pass |
| 138-148 | PATCH | /api/auth/me | patient | email, role, status; empty body; invalid timezone, locale, avatarUrl, phone; null/blank fullName; no token | 400 ValidationFailed (field named) / 401 | as expected | pass |
| 149 | PATCH | /api/auth/me | patient | timezone `+01:00` | 400 ValidationFailed on timezone | **200, stored `+01:00`** | **FAIL** (D-1) |
| 150-156 | POST | /api/auth/forgot-password | public | known and unknown email, invalid, missing | 204 identical headers and empty body; 400; code mailed only for the known email | as expected | pass |
| 227-230 | POST | /api/auth/forgot-password | public | rate limit 3/h per email | 4th call 429 | 4th call 429, Retry-After 3598 | pass |
| 157-162 | POST | /api/auth/reset-password | public | wrong code, unknown email, denylisted/short password, malformed code | 400 ValidationFailed (code / code / newPassword / newPassword / code), unknown email body identical to wrong code | as expected | pass |
| 163-169 | POST | /api/auth/reset-password | public | right code | 204; both older families revoked; old password 401; new password 200; code single use | as expected | pass |
| 170-176 | POST | /api/auth/reset-password | public | 5 wrong attempts, then the right code (limiter cleared) | each 400, right code 400, password unchanged | as expected | pass |
| 177 | POST | /api/auth/reset-password | public | expired code (fixture) | 400 on code | 400 on code | pass |
| 231-238 | POST | /api/auth/reset-password | public | rate limits 5/h per email, 10/h per IP | 6th / 11th call 429 | 6th / 11th call 429, Retry-After 3595 / 3599 | pass |
| 178 | POST | /api/auth/change-password | - | no bearer | 401 Unauthorized | 401 Unauthorized | pass |
| 179-181 | POST | /api/auth/change-password | patient | wrong current password, denylisted new password, missing field | 401 InvalidCredentials, 400 on newPassword, 400 on currentPassword | as expected | pass |
| 182-187 | POST | /api/auth/change-password | patient | success with own cookie | 204; own family still refreshes (200); other family 401; old password 401; new 200 | as expected | pass |
| 188-189 | POST | /api/auth/change-password | patient | success without cookie | 204; every family revoked | as expected | pass |
| 239-242 | POST | /api/auth/change-password | patient | rate limit 5 per 15 min per user | 6th call 429 | 6th call 429, Retry-After 898 | pass |
| 190-192 | GET/PATCH/POST | /api/auth/me, /api/auth/change-password | suspended | pre-suspension token | 403 AccountSuspended | 403 AccountSuspended on all three | pass |
| 193-194 | GET | /api/auth/me | rejected, pending | status is not blocked | 200 | 200 | pass |
| 195-201 | GET | /api/auth/nope, /api/nope, invalid X-Request-Id | - | request id and unknown routes | valid UUID echoed, invalid regenerated and equal to `error.requestId`, 404 NotFound envelope | as expected, `/api/auth/nope` carries no-store | pass |
| 202 | POST | /api/auth/login | public | malformed JSON `{bad` | 400 ValidationFailed (`details[0].field=body`) | 400 ValidationFailed | pass |
| 203 | POST | /api/auth/login | public | same response, `Cache-Control` | `no-store` | **header absent** | **FAIL** (D-2) |
| 204 | OPTIONS | /api/auth/login | public | `Cache-Control` | `no-store` | **404, header absent** (preflight with Origin: 204, no Cache-Control) | **FAIL** (D-3) |
| 205-206 | GET | /api/auth/login, /api/auth/me | - | POST-only route by GET, 401 | 404 NotFound / 401, both no-store | as expected | pass |
| 248-255 | - | api/worker logs, outbox_jobs | - | PII and secret scan, 985 log lines | 0 matches for emails, codes, tokens, refresh tokens, passwords, Authorization/Cookie, JSON secret keys, any `@example.test`; outbox holds ids and state only | 0 matches in every category; columns `id,type,aggregate_id,status,attempts,run_after,locked_until,last_error,request_id,created_at,updated_at,completed_at`; 0 dead jobs | pass |

Observed `Retry-After` values (seconds): login per IP+email 58, login per IP 47, register/start per email 3599, register/start
per IP 3598, register/complete per IP 3599, forgot per email 3598, reset per email 3595, reset per IP 3599,
change-password 898, refresh 42. All 429 responses carried the `RateLimited` envelope, `no-store` and the echoed request id.

## Defects

Three defects are open. They are not fixed here (QA only).

### D-1: PATCH /api/auth/me accepts a fixed UTC offset as a time zone

- Repro (token redacted):
  ```bash
  curl -s -X PATCH http://localhost:3000/api/auth/me \
    -H "Authorization: Bearer <ACCESS_TOKEN>" -H "Content-Type: application/json" \
    -H "X-Request-Id: $(uuidgen)" -d '{"timezone":"+01:00"}'
  ```
- Expected: `400 ValidationFailed`, `details[0].field = "timezone"` ("must be a valid IANA time zone").
- Actual: `200`, the account's `timezone` is now `+01:00`.
- Reference: spec 3.5 (`IsIanaTimeZone`), contract `updateMe` ("`timezone` must be a valid IANA zone"), CLAUDE.md → Domain rules item 10
  ("IANA `timezone` (validated)"). Cause: `src/lib/validation/decorators.ts:49` validates with `new Intl.DateTimeFormat("en-US", { timeZone })`,
  which on Node 24 also accepts offset zones. The same validator guards `register/complete`, so the check likely applies there too
  (not exercised separately). The offset value also flows to Care's token consumers as a "timezone".

### D-2: A malformed JSON body on an /api/auth route returns 400 without `Cache-Control: no-store`

- Repro: `curl -si -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{bad'`
- Expected: `400 ValidationFailed` with `Cache-Control: no-store` (contract: every `/api/auth/*` response; CLAUDE.md → Security rules).
- Actual: `400 ValidationFailed` (`details: [{field: "body", issue: "must be valid JSON"}]`) with no `Cache-Control` header. Same on
  `/api/auth/forgot-password` and `PATCH /api/auth/me`.
- Cause: `express.json` (`src/app.ts:40`) parses before the `/api/auth` router mounts `noStore()` (`src/app/auth/routes.ts:49`),
  so a body-parser error is handed to the error handler without the header.

### D-3: OPTIONS on /api/auth/* returns a response without `Cache-Control: no-store`

- Repro: `curl -si -X OPTIONS http://localhost:3000/api/auth/login` and, with `-H "Origin: http://localhost:5173" -H "Access-Control-Request-Method: POST"`, the development preflight.
- Expected: `no-store` on every `/api/auth/*` response.
- Actual: without Origin a `404 NotFound` envelope, with an allowed Origin a `204` preflight; neither carries `Cache-Control`.
- Cause: `rejectOptions()` (`src/app.ts:38`) and the dev `cors()` preflight answer before the `/api/auth` router and its `noStore()`.
  Low impact (no secret in these responses, and the foundation spec makes the 404 deliberate), so the open question is whether
  the contract rule should exempt `OPTIONS` or the middleware should be moved before both; decide in review.

## Not exercised

| Scenario | Reason |
|---|---|
| Expired access token (`401 TokenExpired`) | Needs a token at least 15 min 30 s old (900 s TTL plus 30 s clock tolerance) or access to the signing key; the signing key must not be touched. Covered by unit tests with an injected clock. |
| Key rotation (two keys in the JWKS) | The stack runs one signing key. |
| Redis-down fallback limiter and fail-open refresh | The brief forbids stopping the stack; covered by the integration suite and by the foundation `RUN_INFRA_CASES` run. |
| Hash-queue saturation (`429` from the argon2 semaphore) | Needs concurrency beyond `HASH_QUEUE_MAX`; not reproducible with sequential CURL. |
| Bcrypt legacy hash rehash on login | No legacy hash fixture is loaded. |
| `X-Forwarded-For` driven limits | `TRUST_PROXY_HOPS=0` on this stack, so the header is ignored by design. |
| Suspended account password reset | Spec allows it, but the run reserves the suspended fixture for the refresh and authenticated-route cases. |
| Unique-violation race on the same email without a SQL fixture | A true race needs two simultaneous completes for different codes; approximated by the fixture insert (check 040). |

## Fix status (2026-10-04, fix-review)
D-1 (fixed-offset timezone), D-2 (malformed JSON 400 without `no-store`) and D-3 (OPTIONS without `no-store`) are fixed in code and covered by unit and integration tests. OPTIONS on `/api/auth/*` stays a `404` envelope (development CORS preflight stays `204`), both now with `Cache-Control: no-store`. `scripts/curl-test-auth.sh` was re-run end to end on a fresh stack on 2026-10-04: **256 pass / 0 fail** (checks 149, 203-205 cover D-1 to D-3). K3 is closed.
