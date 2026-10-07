---
title: users — Manual QA (CURL)
owner: identity-team
service: identity-service
module: users
status: current
diataxis: how-to
last_verified: 2026-10-07
tags: [manual-qa, curl, users, admin, account-status, sessions, rbac]
related: [users-spec, users-tasks, auth-manual-qa, adr-0012-doctor-status-only-via-care, adr-0019-refresh-versus-suspension-lock-order]
---

# users — Manual QA (CURL)

_Run: 2026-10-07 • Server: http://localhost:3000 • Result: 144 pass / 0 fail (script run twice, both green)_

Repeatable form: `scripts/curl-test-users.sh` (`BASE_URL`, `DATABASE_URL` env; needs bash, curl, python, psql, node).

## Environment
Local `tsx src/server.ts` against the host PostgreSQL 18 database `vcare_identity_test` (8 migrations applied, none
pending) and host Redis database 2; a throwaway Ed25519 key and `OTP_PEPPER` generated for the run. Fixtures (admins,
patients, a doctor, pending/rejected/soft-deleted patients) are inserted with SQL; tokens come from `POST /api/auth/login`.
Tokens, cookies and emails are never printed. Two states the API cannot produce (an admin suspended or soft-deleted
after token issue) are set with SQL after login.

## Cases
| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 001-025 | all five | `/api/users...` | none / bad token / patient / doctor / patient + forged `X-Role`,`X-User-Id` | authn and RBAC on every route | 401 Unauthorized / 403 Forbidden | as expected | pass |
| 026-031 | GET | `/api/users` | admin | default list, meta shape, `no-store`, User keys, no secret fields, soft-deleted absent | 200 | 200 | pass |
| 032-037 | GET | `/api/users?limit=2&cursor=` | admin | page 1 and page 2, no overlap, newest first | 200 | 200 | pass |
| 038-047 | GET | `/api/users?role=/status=/email=` | admin | filters, case-insensitive email, soft-deleted email, no match | 200 | 200 | pass |
| 048-056 | GET | `/api/users` | admin | limit 0/101/abc, bad role/status/email, bad cursor, unknown param; limit=100 | 400 ValidationFailed; 200 | as expected | pass |
| 057-060 | GET | `/api/users/{id}` | admin | patient, doctor, `no-store` | 200 | 200 | pass |
| 061-065 | GET | `/api/users/{id}` | admin | absent, soft-deleted, `abc`, `0`, `-1` | 404 NotFound; 400 | as expected | pass |
| 066-070, 081-083 | GET | `/api/users/{id}/sessions` | admin | 3 live families, Session keys, `no-store`, no token/hash in body, empty page | 200 | 200 | pass |
| 071-074 | GET | `/api/users/{id}/sessions?limit=2` | admin | page 1, page 2 (1 left), no overlap | 200 | 200 | pass |
| 075-080 | GET | `/api/users/{id}/sessions` | admin | bad cursor, limit 0, unknown param, absent, soft-deleted, `abc` | 400 / 404 | as expected | pass |
| 084-090 | PATCH | `/api/users/{id}/status` | admin | suspend patient: 200 `{id,status,updatedAt}`, 1 history row (actor admin, service null), 0 live tokens, `status_changed` | 200 | 200 | pass |
| 091-092 | POST | `/api/auth/refresh`, `/api/auth/login` | patient | after suspension | refresh 401 RefreshTokenInvalid (see N-1); login 403 AccountSuspended | as expected | pass |
| 093-095 | PATCH | `/api/users/{id}/status` | admin | suspend again (no-op, still 1 row); replay with same `Idempotency-Key` | 200 | 200 | pass |
| 096-101 | PATCH | `/api/users/{id}/status` | admin | reinstate (2nd history row), login works, active to active no-op | 200 | 200 | pass |
| 102-107 | PATCH | `/api/users/{id}/status` | admin | target self / another admin / doctor, also same-status; no history written | 403 Forbidden | 403 | pass |
| 108-109 | PATCH | `/api/users/{id}/status` | admin | suspend pending patient, activate rejected patient | 409 InvalidStatusTransition | 409 | pass |
| 111-114 | PATCH | `/api/users/{id}/status` | admin | absent, soft-deleted, `abc`, `0` | 404 NotFound; 400 | as expected | pass |
| 115-123 | PATCH | `/api/users/{id}/status` | admin | status pending/rejected/bogus/missing, reason missing/empty/blank/501 chars, extra field | 400 ValidationFailed | 400 | pass |
| 125-129 | PATCH, DELETE, GET | status / sessions | admin suspended or soft-deleted after token issue | live-actor re-read (D-5); GET relies on the claim | 403 AccountSuspended / 401 Unauthorized / 200 | as expected | pass |
| 130-137 | DELETE | `/api/users/{id}/sessions` | admin | 204 empty body, 0 live tokens, `admin_revoked`, repeat 204, body ignored, list now empty | 204 | 204 | pass |
| 138 | POST | `/api/auth/refresh` | patient | refresh after admin revoke | 401 | 401 RefreshTokenInvalid | pass |
| 139-142 | DELETE | `/api/users/{id}/sessions` | admin | absent, soft-deleted, `abc`; own sessions | 404 / 400 / 204 | as expected | pass |
| 143-144 | GET | `/api/users` | admin | invalid `X-Request-Id` regenerated; valid one echoed on all 100 requests | echoed | echoed | pass |

## Failures / notes
- No contract failures; no 500 observed.
- **N-1 (spec wording, not a behavior bug):** `docs/users/spec.md` BR-8 and section 10.2 say the refresh after a suspension returns
  `403 AccountSuspended`. Actual (and asserted by `tests/integration/users/concurrency.test.ts:176`) is `401 RefreshTokenInvalid`
  with a clearing cookie, because the suspension already revoked the family before the refresh reached the user re-read. The
  `403 AccountSuspended` path occurs only when the status changes while a refresh waits on the user lock (test line 187).
  The contract allows both; fix the spec wording in `/update-docs users`.
- Not exercised by CURL: an expired access token (`TokenExpired`) and an admin token whose claim is `suspended` (login refuses suspended
  accounts, so such a token cannot be obtained); both are covered by integration/RBAC tests. Server log redaction (`reason`,
  email filter) was not inspected in this run (server output was not captured).
- Contract lists no `Idempotency-Key` for these operations; the header was sent on one PATCH and was harmless.
