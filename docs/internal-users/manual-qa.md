---
title: internal-users — Manual QA (CURL)
owner: identity-team
service: identity-service
module: internal-users
status: ready
diataxis: how-to
last_verified: 2026-10-08
tags: [manual-qa, internal-users, curl, internal-listener, service-token, account-status, batch-lookup, contacts]
related: [internal-users-spec, adr-0023-internal-status-accepts-suspended-to-active, adr-0024-notification-contacts-lookup-and-scope, adr-0025-internal-status-route-doctor-targets-only, service-auth]
---

# internal-users — Manual QA (CURL)

_Run: 2026-10-08 • Server: public http://localhost:3200, internal http://localhost:3300 (dedicated QA instance, see note N-1) • Result: 219 pass / 0 fail_

Repeat the run with [`scripts/curl-test-internal-users.sh`](../../scripts/curl-test-internal-users.sh) (env: `DATABASE_URL`
of the server's own database, `PUBLIC_URL`, `INTERNAL_URL`, optional `SERVER_LOG`). Compared against
`contracts/openapi.yaml` (`batchGetUsers`, `getUserContacts`, `internalUpdateUserStatus`), `docs/internal-users/spec.md`
and ADR 0025. All data is synthetic (`@example.test`); tokens, cookies, secrets, emails and phone numbers are never
printed. Every request carried a fresh `X-Request-Id`; the echo was verified on all 123 `req` calls (0 mismatches), and an
invalid id (`not-a-uuid`) is replaced by a generated UUID.

## Coverage summary

| Area | Scenarios exercised | Result |
|---|---|---|
| `GET /internal/users` (Case 2) | no/garbage token, patient/doctor/admin user tokens (+ forged `X-User-Id`/`X-Role`) -> 401 `ServiceTokenRequired`; wrong scope -> 403 `InsufficientScope` (checked before validation); unknown and soft-deleted ids omitted; all-unknown -> `[]`; duplicates collapsed; 100 ids ok; 101 ids and 101 duplicates -> 400; 13 malformed `ids` forms -> 400; no email/phone/hash anywhere | pass |
| `GET /internal/users/contacts` (Case 5) | same authn matrix; `users:read`, `users:status:write` and care-service tokens scoped otherwise -> 403; care-service `users:contact:read` -> 200 with `Cache-Control: no-store`, keys exactly `id,email,fullName,locale,status`, no phone; unknown/deleted omitted; 100 ok, 101 -> 400; a non-care client cannot hold the scope (DB `CHECK`, and the token endpoint answers 403) | pass |
| `PATCH /internal/users/{id}/status` authn, scope, validation | 401 matrix, 403 scope before path/body validation and before lookup, 19 validation failures, 400 wins over 404 and over 403 | pass |
| ADR 0025 | patient and admin target x 4 statuses -> 403 `Forbidden`; no status or `updated_at` change, no history row, no refresh token revoked; absent and soft-deleted targets -> 404 first | pass |
| Cases 1, 3, 4 | pending->active, pending->rejected (revokes, rejected may sign in and refresh), rejected->pending, active->suspended (revokes all families, refresh and login refused), suspended->active (nothing revived, login works), history row content incl. `actor_service` and the caller's `request_id` | pass |
| Idempotent no-ops | repeat `active` and `pending`: 200, no history row, `updatedAt` unchanged; repeat `rejected`: no revoke; repeat `suspended`: no history row and revokes a live token planted by SQL | pass |
| Transition matrix | all 16 ordered pairs on a scratch doctor: 5 allowed, 4 same-status no-ops, 7 -> 409 `InvalidStatusTransition`, with status, history count and refresh tokens verified after each | pass |
| `actorUserId` as data | unknown id -> 200 and `actor_user_id` NULL; soft-deleted actor and patient actor recorded as is | pass |
| Boundaries | internal routes 404 on the public listener; service token on a public route -> 401; `Idempotency-Key` ignored on GET and PATCH | pass |
| Log hygiene | no reason text, email, phone, JWT or Authorization text in the server log; `status_change_actor_unknown` (warn), `user_status_changed` and a counts-only contacts event present; no error-level line | pass |

## Cases

Role legend: `none` no token; `garbage` malformed token; `*-user` a user access token from `/api/auth/login`;
`svc:*` a service token (care-service or a QA client) with the scope named; `log` server log grep. Path ids are the
synthetic fixture ids of this run.

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 1 | GET | `/internal/users?ids=14,15,987654321,23,22` | none | no token | 401 ServiceTokenRequired | 401 ServiceTokenRequired | PASS |
| 2 | GET | `/internal/users?ids=14,15,987654321,23,22` | garbage | malformed token | 401 ServiceTokenRequired | 401 ServiceTokenRequired | PASS |
| 3 | GET | `/internal/users?ids=14,15,987654321,23,22` | patient-user | patient user token | 401 ServiceTokenRequired | 401 ServiceTokenRequired | PASS |
| 4 | GET | `/internal/users?ids=14,15,987654321,23,22` | doctor-user | doctor user token | 401 ServiceTokenRequired | 401 ServiceTokenRequired | PASS |
| 5 | GET | `/internal/users?ids=14,15,987654321,23,22` | admin-user | admin user token (even an admin's) | 401 ServiceTokenRequired | 401 ServiceTokenRequired | PASS |
| 6 | GET | `/internal/users?ids=14,15,987654321,23,22` | admin-user+forged | user token + forged X-User-Id/X-Role headers | 401 ServiceTokenRequired | 401 ServiceTokenRequired | PASS |
| 7 | GET | `/internal/users?ids=14,15,987654321,23,22` | svc:status-only | scope users:status:write is not users:read | 403 InsufficientScope | 403 InsufficientScope | PASS |
| 8 | GET | `/internal/users?ids=14,15,987654321,23,22` | svc:contact-only | scope users:contact:read is not users:read | 403 InsufficientScope | 403 InsufficientScope | PASS |
| 9 | GET | `/internal/users` | svc:status-only | scope checked before validation (missing ids) | 403 InsufficientScope | 403 InsufficientScope | PASS |
| 10 | GET | `/internal/users?ids=14,15,987654321,23,22` | svc:read | happy path: qa client with users:read | 200 | 200 | PASS |
| 11 | GET | `/internal/users?ids=14,15,987654321,23,22` | svc:read | omits unknown, soft-deleted patient and soft-deleted doctor | 14,15 | 14,15 | PASS |
| 12 | GET | `/internal/users?ids=14,15,987654321,23,22` | svc:read | summary keys are exactly the contract UserSummary | avatarUrl,fullName,id,locale,role,status,timezone | avatarUrl,fullName,id,locale,role,status,timezone | PASS |
| 13 | GET | `/internal/users?ids=14,15,987654321,23,22` | svc:read | no email in body | 0 | 0 | PASS |
| 14 | GET | `/internal/users?ids=14,15,987654321,23,22` | svc:read | no phone in body | 0 | 0 | PASS |
| 15 | GET | `/internal/users?ids=14,15,987654321,23,22` | svc:read | no hash/secret key in body | 0 | 0 | PASS |
| 16 | GET | `/internal/users?ids=14,15,987654321,23,22` | svc:read | X-Request-Id echoed | 81ea0de7-c37b-4ba8-a3de-a5b86e18533e | 81ea0de7-c37b-4ba8-a3de-a5b86e18533e | PASS |
| 17 | GET | `/internal/users?ids=14,15,987654321,23,22` | svc:read | avatarUrl is null (not absent) for a user without one | want | got | PASS |
| 18 | GET | `/internal/users?ids=987654321,23` | svc:care-read | all ids unknown or deleted | 200 | 200 | PASS |
| 19 | GET | `/internal/users?ids=987654321,23` | svc:care-read | all-unknown: data is [] | [] | [] | PASS |
| 20 | GET | `/internal/users?ids=14,14` | svc:care-read | duplicate ids are collapsed (D-9) | 200 | 200 | PASS |
| 21 | GET | `/internal/users?ids=14,14` | svc:care-read | duplicate ids: one row | 14 | 14 | PASS |
| 22 | GET | `/internal/users?ids=<long list>` | svc:care-read | exactly 100 ids | 200 | 200 | PASS |
| 23 | GET | `/internal/users?ids=<long list>` | svc:care-read | 100 ids: at most 100 rows | ~ ^([0-9]\|[1-9][0-9]\|100)$ | 18 | PASS |
| 24 | GET | `/internal/users?ids=<long list>` | svc:care-read | 101 ids -> cap | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 25 | GET | `/internal/users?ids=<long list>` | svc:care-read | 101 ids: error.details[0].field is ids | ids | ids | PASS |
| 26 | GET | `/internal/users?ids=<long list>` | svc:care-read | 101 duplicate entries (cap counts as sent) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 27 | GET | `/internal/users` | svc:care-read | bad ids: '<no query>' | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 28 | GET | `/internal/users?ids=` | svc:care-read | bad ids: '?ids=' | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 29 | GET | `/internal/users?ids=1,,2` | svc:care-read | bad ids: '?ids=1,,2' | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 30 | GET | `/internal/users?ids=abc` | svc:care-read | bad ids: '?ids=abc' | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 31 | GET | `/internal/users?ids=0` | svc:care-read | bad ids: '?ids=0' | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 32 | GET | `/internal/users?ids=-1` | svc:care-read | bad ids: '?ids=-1' | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 33 | GET | `/internal/users?ids=01` | svc:care-read | bad ids: '?ids=01' | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 34 | GET | `/internal/users?ids=1.5` | svc:care-read | bad ids: '?ids=1.5' | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 35 | GET | `/internal/users?ids=1,2,` | svc:care-read | bad ids: '?ids=1,2,' | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 36 | GET | `/internal/users?ids=1&ids=2` | svc:care-read | bad ids: '?ids=1&ids=2' | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 37 | GET | `/internal/users?ids=1&foo=bar` | svc:care-read | bad ids: '?ids=1&foo=bar' | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 38 | GET | `/internal/users?ids=9007199254740993` | svc:care-read | bad ids: '?ids=9007199254740993' | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 39 | GET | `/internal/users?ids=%20` | svc:care-read | bad ids: '?ids=%20' | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 40 | GET | `/internal/users?ids=14` | svc:read | Idempotency-Key ignored on GET | 200 | 200 | PASS |
| 41 | GET | `/internal/users/contacts?ids=14,15,987654321,23` | none | no token | 401 ServiceTokenRequired | 401 ServiceTokenRequired | PASS |
| 42 | GET | `/internal/users/contacts?ids=14,15,987654321,23` | patient-user | patient user token | 401 ServiceTokenRequired | 401 ServiceTokenRequired | PASS |
| 43 | GET | `/internal/users/contacts?ids=14,15,987654321,23` | doctor-user | doctor user token | 401 ServiceTokenRequired | 401 ServiceTokenRequired | PASS |
| 44 | GET | `/internal/users/contacts?ids=14,15,987654321,23` | admin-user | admin user token | 401 ServiceTokenRequired | 401 ServiceTokenRequired | PASS |
| 45 | GET | `/internal/users/contacts?ids=14,15,987654321,23` | svc:read | qa client with users:read only | 403 InsufficientScope | 403 InsufficientScope | PASS |
| 46 | GET | `/internal/users/contacts?ids=14,15,987654321,23` | svc:care-read | care-service token scoped users:read | 403 InsufficientScope | 403 InsufficientScope | PASS |
| 47 | GET | `/internal/users/contacts?ids=14,15,987654321,23` | svc:care-stat | care-service token scoped users:status:write | 403 InsufficientScope | 403 InsufficientScope | PASS |
| 48 | GET | `/internal/users/contacts` | svc:read | scope checked before validation (missing ids) | 403 InsufficientScope | 403 InsufficientScope | PASS |
| 49 | GET | `/internal/users/contacts?ids=14,15,987654321,23` | svc:care-contact | happy path: care-service with users:contact:read | 200 | 200 | PASS |
| 50 | GET | `/internal/users/contacts?ids=14,15,987654321,23` | svc:care-contact | Cache-Control: no-store | no-store | no-store | PASS |
| 51 | GET | `/internal/users/contacts?ids=14,15,987654321,23` | svc:care-contact | X-Request-Id echoed | 9809fff2-851c-4d6a-9a1c-9a28fa8c3811 | 9809fff2-851c-4d6a-9a1c-9a28fa8c3811 | PASS |
| 52 | GET | `/internal/users/contacts?ids=14,15,987654321,23` | svc:care-contact | omits unknown and soft-deleted ids | 14,15 | 14,15 | PASS |
| 53 | GET | `/internal/users/contacts?ids=14,15,987654321,23` | svc:care-contact | contact keys are exactly the contract UserContact (no phone) | email,fullName,id,locale,status | email,fullName,id,locale,status | PASS |
| 54 | GET | `/internal/users/contacts?ids=14,15,987654321,23` | svc:care-contact | email returned for the patient | @example.test | @example.test | PASS |
| 55 | GET | `/internal/users/contacts?ids=14,15,987654321,23` | svc:care-contact | no phone value or key in body | 0 | 0 | PASS |
| 56 | GET | `/internal/users/contacts?ids=14,15,987654321,23` | svc:care-contact | no hash/secret key in body | 0 | 0 | PASS |
| 57 | GET | `/internal/users/contacts?ids=<long list>` | svc:care-all | exactly 100 ids | 200 | 200 | PASS |
| 58 | GET | `/internal/users/contacts?ids=<long list>` | svc:care-all | 101 ids -> cap | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 59 | GET | `/internal/users/contacts` | svc:care-all | bad ids: '<no query>' | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 60 | GET | `/internal/users/contacts?ids=` | svc:care-all | bad ids: '?ids=' | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 61 | GET | `/internal/users/contacts?ids=1,,2` | svc:care-all | bad ids: '?ids=1,,2' | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 62 | GET | `/internal/users/contacts?ids=abc` | svc:care-all | bad ids: '?ids=abc' | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 63 | GET | `/internal/users/contacts?ids=0` | svc:care-all | bad ids: '?ids=0' | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 64 | GET | `/internal/users/contacts?ids=1&ids=2` | svc:care-all | bad ids: '?ids=1&ids=2' | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 65 | GET | `/internal/users/contacts?ids=1&foo=bar` | svc:care-all | bad ids: '?ids=1&foo=bar' | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 66 | GET | `/internal/users/contacts?ids=1&foo=bar` | svc:care-all | DB refuses users:contact:read on a non-care client (chk_service_clients_contact_scope_care_only) | 1 | 1 | PASS |
| 67 | POST | `/internal/auth/token` | none | token endpoint refuses users:contact:read to a non-care client | 403 InsufficientScope | 403 InsufficientScope | PASS |
| 68 | PATCH | `/internal/users/16/status` | none | no token | 401 ServiceTokenRequired | 401 ServiceTokenRequired | PASS |
| 69 | PATCH | `/internal/users/16/status` | garbage | malformed token | 401 ServiceTokenRequired | 401 ServiceTokenRequired | PASS |
| 70 | PATCH | `/internal/users/16/status` | patient-user | patient user token | 401 ServiceTokenRequired | 401 ServiceTokenRequired | PASS |
| 71 | PATCH | `/internal/users/16/status` | doctor-user | doctor user token | 401 ServiceTokenRequired | 401 ServiceTokenRequired | PASS |
| 72 | PATCH | `/internal/users/16/status` | admin-user | admin user token | 401 ServiceTokenRequired | 401 ServiceTokenRequired | PASS |
| 73 | PATCH | `/internal/users/16/status` | admin-user+forged | user token + forged identity headers | 401 ServiceTokenRequired | 401 ServiceTokenRequired | PASS |
| 74 | PATCH | `/internal/users/16/status` | svc:read | users:read token | 403 InsufficientScope | 403 InsufficientScope | PASS |
| 75 | PATCH | `/internal/users/16/status` | svc:care-contact | users:contact:read token | 403 InsufficientScope | 403 InsufficientScope | PASS |
| 76 | PATCH | `/internal/users/abc/status` | svc:read | scope checked before path/body validation | 403 InsufficientScope | 403 InsufficientScope | PASS |
| 77 | PATCH | `/internal/users/{id}/status` | svc:read | scope checked before target lookup (absent id) | 403 InsufficientScope | 403 InsufficientScope | PASS |
| 78 | PATCH | `/internal/users/{id}/status` | svc:read | no write from refused calls (d1 still pending, 0 history) | pending/0 | pending/0 | PASS |
| 79 | PATCH | `/internal/users/abc/status` | svc:status | id=abc | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 80 | PATCH | `/internal/users/0/status` | svc:status | id=0 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 81 | PATCH | `/internal/users/-1/status` | svc:status | id=-1 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 82 | PATCH | `/internal/users/01/status` | svc:status | id=01 (leading zero) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 83 | PATCH | `/internal/users/16/status` | svc:status | missing actorUserId | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 84 | PATCH | `/internal/users/16/status` | svc:status | missing status | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 85 | PATCH | `/internal/users/16/status` | svc:status | missing reason | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 86 | PATCH | `/internal/users/16/status` | svc:status | status outside the four values | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 87 | PATCH | `/internal/users/16/status` | svc:status | empty reason | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 88 | PATCH | `/internal/users/16/status` | svc:status | blank reason | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 89 | PATCH | `/internal/users/16/status` | svc:status | reason 501 chars | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 90 | PATCH | `/internal/users/16/status` | svc:status | actorUserId as a string | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 91 | PATCH | `/internal/users/16/status` | svc:status | actorUserId 0 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 92 | PATCH | `/internal/users/16/status` | svc:status | actorUserId 1.5 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 93 | PATCH | `/internal/users/16/status` | svc:status | unknown body field | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 94 | PATCH | `/internal/users/16/status` | svc:status | malformed JSON | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 95 | PATCH | `/internal/users/16/status` | svc:status | empty body | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 96 | PATCH | `/internal/users/{id}/status` | svc:status | invalid body on an absent target is 400, not 404 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 97 | PATCH | `/internal/users/14/status` | svc:status | invalid body on a patient target is 400, not 403 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 98 | PATCH | `/internal/users/14/status` | svc:status | validation failures wrote nothing (d1 pending, 0 history, patient active) | pending/0/active | pending/0/active | PASS |
| 99 | PATCH | `/internal/users/{id}/status` | svc:status | absent target | 404 NotFound | 404 NotFound | PASS |
| 100 | PATCH | `/internal/users/22/status` | svc:status | soft-deleted doctor | 404 NotFound | 404 NotFound | PASS |
| 101 | PATCH | `/internal/users/23/status` | svc:status | soft-deleted patient (404 before the role check) | 404 NotFound | 404 NotFound | PASS |
| 102 | PATCH | `/internal/users/14/status` | svc:status | patient target, status=active | 403 Forbidden | 403 Forbidden | PASS |
| 103 | PATCH | `/internal/users/13/status` | svc:status | admin target (the actor itself), status=active | 403 Forbidden | 403 Forbidden | PASS |
| 104 | PATCH | `/internal/users/14/status` | svc:status | patient target, status=suspended | 403 Forbidden | 403 Forbidden | PASS |
| 105 | PATCH | `/internal/users/13/status` | svc:status | admin target (the actor itself), status=suspended | 403 Forbidden | 403 Forbidden | PASS |
| 106 | PATCH | `/internal/users/14/status` | svc:status | patient target, status=rejected | 403 Forbidden | 403 Forbidden | PASS |
| 107 | PATCH | `/internal/users/13/status` | svc:status | admin target (the actor itself), status=rejected | 403 Forbidden | 403 Forbidden | PASS |
| 108 | PATCH | `/internal/users/14/status` | svc:status | patient target, status=pending | 403 Forbidden | 403 Forbidden | PASS |
| 109 | PATCH | `/internal/users/13/status` | svc:status | admin target (the actor itself), status=pending | 403 Forbidden | 403 Forbidden | PASS |
| 110 | PATCH | `/internal/users/13/status` | svc:status | patient: status unchanged, updated_at unchanged, no history | active/same/0 | active/same/0 | PASS |
| 111 | PATCH | `/internal/users/13/status` | svc:status | admin: status unchanged, updated_at unchanged, no history | active/same/0 | active/same/0 | PASS |
| 112 | PATCH | `/internal/users/13/status` | svc:status | patient: refresh tokens not revoked (2 live before) | 2 | 2 | PASS |
| 113 | PATCH | `/internal/users/13/status` | svc:status | admin: refresh tokens not revoked | 1 | 1 | PASS |
| 114 | POST | `/api/auth/refresh` | patient | patient's refresh still works after the refused calls | 200 | 200 | PASS |
| 115 | POST | `/api/auth/login` | none | d1 pending can log in (live token) | 1 | 1 | PASS |
| 116 | PATCH | `/internal/users/16/status` | svc:care-stat | pending -> active | 200 | 200 | PASS |
| 117 | PATCH | `/internal/users/16/status` | svc:care-stat | response data keys are exactly id,status,updatedAt | id,status,updatedAt | id,status,updatedAt | PASS |
| 118 | PATCH | `/internal/users/16/status` | svc:care-stat | response data.status | active | active | PASS |
| 119 | PATCH | `/internal/users/16/status` | svc:care-stat | response data.id | 16 | 16 | PASS |
| 120 | PATCH | `/internal/users/16/status` | svc:care-stat | X-Request-Id echoed | 103d4445-93ac-453f-81a6-a0c6bb2438f1 | 103d4445-93ac-453f-81a6-a0c6bb2438f1 | PASS |
| 121 | PATCH | `/internal/users/16/status` | svc:care-stat | users row is active | active | active | PASS |
| 122 | PATCH | `/internal/users/16/status` | svc:care-stat | one history row: pending->active, actor_user_id, actor_service=care-service, request_id=caller's | 1,true,true | 1,true,true | PASS |
| 123 | PATCH | `/internal/users/16/status` | svc:care-stat | entering active revoked nothing (token still live) | 1 | 1 | PASS |
| 124 | PATCH | `/internal/users/16/status` | svc:care-stat | repeat active (no-op) | 200 | 200 | PASS |
| 125 | PATCH | `/internal/users/16/status` | svc:care-stat | repeat active: still 1 history row | 1 | 1 | PASS |
| 126 | PATCH | `/internal/users/16/status` | svc:care-stat | repeat active: updatedAt unchanged | 2026-10-08T20:19:06.438Z | 2026-10-08T20:19:06.438Z | PASS |
| 127 | PATCH | `/internal/users/16/status` | svc:care-stat | Idempotency-Key ignored on PATCH (no 422/409) | 200 | 200 | PASS |
| 128 | POST | `/api/auth/login` | none | d2 has 2 live families | 2 | 2 | PASS |
| 129 | PATCH | `/internal/users/17/status` | svc:care-stat | pending -> rejected | 200 | 200 | PASS |
| 130 | PATCH | `/internal/users/17/status` | svc:care-stat | all families revoked, reason status_changed | 0/status_changed | 0/status_changed | PASS |
| 131 | PATCH | `/internal/users/17/status` | svc:care-stat | one history row pending->rejected | 1,true | 1,true | PASS |
| 132 | POST | `/api/auth/refresh` | doctor | old cookie after rejection is dead | 401 RefreshTokenInvalid | 401 RefreshTokenInvalid | PASS |
| 133 | POST | `/api/auth/login` | none | rejected doctor can log in (ADR 0004) | 200 | 200 | PASS |
| 134 | POST | `/api/auth/login` | none | login token carries status rejected | rejected | rejected | PASS |
| 135 | POST | `/api/auth/login` | none | rejected doctor can refresh | 200 | 200 | PASS |
| 136 | PATCH | `/internal/users/17/status` | svc:care-stat | repeat rejected (no-op) | 200 | 200 | PASS |
| 137 | PATCH | `/internal/users/17/status` | svc:care-stat | repeat rejected: live token NOT revoked (ADR 0004, D-5) | 1 | 1 | PASS |
| 138 | PATCH | `/internal/users/17/status` | svc:care-stat | repeat rejected: still 1 history row | 1 | 1 | PASS |
| 139 | PATCH | `/internal/users/17/status` | svc:care-stat | rejected -> pending (re-open) | 200 | 200 | PASS |
| 140 | PATCH | `/internal/users/17/status` | svc:care-stat | pending revoked nothing; 2 history rows | 1/2 | 1/2 | PASS |
| 141 | PATCH | `/internal/users/17/status` | svc:care-stat | repeat pending (no-op) | 200 | 200 | PASS |
| 142 | PATCH | `/internal/users/17/status` | svc:care-stat | repeat pending: still 2 history rows | 2 | 2 | PASS |
| 143 | POST | `/api/auth/login` | none | d3 has 2 live families | 2 | 2 | PASS |
| 144 | PATCH | `/internal/users/18/status` | svc:care-stat | active -> suspended | 200 | 200 | PASS |
| 145 | PATCH | `/internal/users/18/status` | svc:care-stat | response status | suspended | suspended | PASS |
| 146 | PATCH | `/internal/users/18/status` | svc:care-stat | all families revoked, reason status_changed | 0/status_changed | 0/status_changed | PASS |
| 147 | PATCH | `/internal/users/18/status` | svc:care-stat | one history row active->suspended | 1,true | 1,true | PASS |
| 148 | POST | `/api/auth/refresh` | doctor | refresh with a pre-suspension cookie fails | ~ ^(401 RefreshTokenInvalid\|403 AccountSuspended)$ | 401 RefreshTokenInvalid | PASS |
| 149 | POST | `/api/auth/refresh` | doctor | refresh with a pre-suspension cookie fails | ~ ^(401 RefreshTokenInvalid\|403 AccountSuspended)$ | 401 RefreshTokenInvalid | PASS |
| 150 | POST | `/api/auth/login` | none | login refused for suspended doctor | 403 AccountSuspended | 403 AccountSuspended | PASS |
| 151 | PATCH | `/internal/users/18/status` | svc:care-stat | repeat suspended (no-op) | 200 | 200 | PASS |
| 152 | PATCH | `/internal/users/18/status` | svc:care-stat | repeat suspended: updatedAt unchanged, still 1 history row | same/1 | same/1 | PASS |
| 153 | POST | `/api/auth/login` | none | setup: suspended with 1 live token, 0 history | suspended/1/0 | suspended/1/0 | PASS |
| 154 | PATCH | `/internal/users/19/status` | svc:care-stat | repeat suspended on a suspended doctor with a live token | 200 | 200 | PASS |
| 155 | PATCH | `/internal/users/19/status` | svc:care-stat | live token revoked, no history row written | 0/0 | 0/0 | PASS |
| 156 | PATCH | `/internal/users/18/status` | svc:care-stat | suspended -> active (reinstatement) | 200 | 200 | PASS |
| 157 | PATCH | `/internal/users/18/status` | svc:care-stat | response status | active | active | PASS |
| 158 | PATCH | `/internal/users/18/status` | svc:care-stat | 2 history rows; last is suspended->active | 2/suspended>active | 2/suspended>active | PASS |
| 159 | PATCH | `/internal/users/18/status` | svc:care-stat | old tokens stay revoked (nothing revived) | 0 | 0 | PASS |
| 160 | POST | `/api/auth/login` | none | doctor can sign in again | 200 | 200 | PASS |
| 161 | PATCH | `/internal/users/18/status` | svc:care-stat | repeat active (retried Case 4) | 200 | 200 | PASS |
| 162 | PATCH | `/internal/users/18/status` | svc:care-stat | repeat active: updatedAt unchanged, still 2 history rows, new login token kept | same/2/1 | same/2/1 | PASS |
| 163 | PATCH | `/api/users/18/status` | admin | public admin route still refuses a doctor target (ADR 0012) | 403 Forbidden | 403 Forbidden | PASS |
| 164 | PATCH | `/internal/users/20/status` | svc:status-qa | pending -> pending (same status, no-op) | 200 | 200 | PASS |
| 165 | PATCH | `/internal/users/20/status` | svc:status-qa | pending -> pending: status stays, no history row | pending/0 | pending/0 | PASS |
| 166 | PATCH | `/internal/users/20/status` | svc:status-qa | pending -> active (allowed) | 200 | 200 | PASS |
| 167 | PATCH | `/internal/users/20/status` | svc:status-qa | pending -> active: status moved, 1 history row | active/1 | active/1 | PASS |
| 168 | PATCH | `/internal/users/20/status` | svc:status-qa | pending -> rejected (allowed) | 200 | 200 | PASS |
| 169 | PATCH | `/internal/users/20/status` | svc:status-qa | pending -> rejected: status moved, 1 history row | rejected/1 | rejected/1 | PASS |
| 170 | PATCH | `/internal/users/20/status` | svc:status-qa | pending -> suspended (invalid) | 409 InvalidStatusTransition | 409 InvalidStatusTransition | PASS |
| 171 | PATCH | `/internal/users/20/status` | svc:status-qa | pending -> suspended: status stays, no history row | pending/0 | pending/0 | PASS |
| 172 | PATCH | `/internal/users/20/status` | svc:status-qa | active -> pending (invalid) | 409 InvalidStatusTransition | 409 InvalidStatusTransition | PASS |
| 173 | PATCH | `/internal/users/20/status` | svc:status-qa | active -> pending: status stays, no history row | active/0 | active/0 | PASS |
| 174 | PATCH | `/internal/users/20/status` | svc:status-qa | active -> active (same status, no-op) | 200 | 200 | PASS |
| 175 | PATCH | `/internal/users/20/status` | svc:status-qa | active -> active: status stays, no history row | active/0 | active/0 | PASS |
| 176 | PATCH | `/internal/users/20/status` | svc:status-qa | active -> rejected (invalid) | 409 InvalidStatusTransition | 409 InvalidStatusTransition | PASS |
| 177 | PATCH | `/internal/users/20/status` | svc:status-qa | active -> rejected: status stays, no history row | active/0 | active/0 | PASS |
| 178 | PATCH | `/internal/users/20/status` | svc:status-qa | active -> suspended (allowed) | 200 | 200 | PASS |
| 179 | PATCH | `/internal/users/20/status` | svc:status-qa | active -> suspended: status moved, 1 history row | suspended/1 | suspended/1 | PASS |
| 180 | PATCH | `/internal/users/20/status` | svc:status-qa | rejected -> pending (allowed) | 200 | 200 | PASS |
| 181 | PATCH | `/internal/users/20/status` | svc:status-qa | rejected -> pending: status moved, 1 history row | pending/1 | pending/1 | PASS |
| 182 | PATCH | `/internal/users/20/status` | svc:status-qa | rejected -> active (invalid) | 409 InvalidStatusTransition | 409 InvalidStatusTransition | PASS |
| 183 | PATCH | `/internal/users/20/status` | svc:status-qa | rejected -> active: status stays, no history row | rejected/0 | rejected/0 | PASS |
| 184 | PATCH | `/internal/users/20/status` | svc:status-qa | rejected -> rejected (same status, no-op) | 200 | 200 | PASS |
| 185 | PATCH | `/internal/users/20/status` | svc:status-qa | rejected -> rejected: status stays, no history row | rejected/0 | rejected/0 | PASS |
| 186 | PATCH | `/internal/users/20/status` | svc:status-qa | rejected -> suspended (invalid) | 409 InvalidStatusTransition | 409 InvalidStatusTransition | PASS |
| 187 | PATCH | `/internal/users/20/status` | svc:status-qa | rejected -> suspended: status stays, no history row | rejected/0 | rejected/0 | PASS |
| 188 | PATCH | `/internal/users/20/status` | svc:status-qa | suspended -> pending (invalid) | 409 InvalidStatusTransition | 409 InvalidStatusTransition | PASS |
| 189 | PATCH | `/internal/users/20/status` | svc:status-qa | suspended -> pending: status stays, no history row | suspended/0 | suspended/0 | PASS |
| 190 | PATCH | `/internal/users/20/status` | svc:status-qa | suspended -> active (allowed) | 200 | 200 | PASS |
| 191 | PATCH | `/internal/users/20/status` | svc:status-qa | suspended -> active: status moved, 1 history row | active/1 | active/1 | PASS |
| 192 | PATCH | `/internal/users/20/status` | svc:status-qa | suspended -> rejected (invalid) | 409 InvalidStatusTransition | 409 InvalidStatusTransition | PASS |
| 193 | PATCH | `/internal/users/20/status` | svc:status-qa | suspended -> rejected: status stays, no history row | suspended/0 | suspended/0 | PASS |
| 194 | PATCH | `/internal/users/20/status` | svc:status-qa | suspended -> suspended (same status, no-op) | 200 | 200 | PASS |
| 195 | PATCH | `/internal/users/20/status` | svc:status-qa | suspended -> suspended: status stays, no history row | suspended/0 | suspended/0 | PASS |
| 196 | PATCH | `/internal/users/20/status` | svc:status-qa | matrix wrote exactly one history row per real change | 5 | 5 | PASS |
| 197 | PATCH | `/internal/users/20/status` | svc:status-qa | actor_service is the token sub (qa client, not a header) | qa-iu-1791490645666-status | qa-iu-1791490645666-status | PASS |
| 198 | PATCH | `/internal/users/20/status` | svc:status-qa | active -> rejected (409) with a live token present | 409 InvalidStatusTransition | 409 InvalidStatusTransition | PASS |
| 199 | PATCH | `/internal/users/20/status` | svc:status-qa | 409 revoked nothing (live token count unchanged; 1 before) | 1 | 1 | PASS |
| 200 | PATCH | `/internal/users/21/status` | svc:care-stat | unknown actorUserId -> still 200 | 200 | 200 | PASS |
| 201 | PATCH | `/internal/users/21/status` | svc:care-stat | unknown actor stored as NULL, actor_service kept, request_id kept | true,care-service,true | true,care-service,true | PASS |
| 202 | PATCH | `/internal/users/21/status` | svc:care-stat | soft-deleted actorUserId -> 200 | 200 | 200 | PASS |
| 203 | PATCH | `/internal/users/21/status` | svc:care-stat | soft-deleted actor id recorded as is | 24 | 24 | PASS |
| 204 | PATCH | `/internal/users/21/status` | svc:care-stat | patient actorUserId (no role check on actor) -> 200 | 200 | 200 | PASS |
| 205 | PATCH | `/internal/users/21/status` | svc:care-stat | patient actor id recorded as is; 3 history rows | 14/3 | 14/3 | PASS |
| 206 | GET | `/internal/users?ids=14` | none | internal route is not served on the public listener | 404 NotFound | 404 NotFound | PASS |
| 207 | PATCH | `/internal/users/16/status` | none | internal status route not on the public listener | 404 NotFound | 404 NotFound | PASS |
| 208 | GET | `/api/users` | none | service token on a public user route | 401 Unauthorized | 401 Unauthorized | PASS |
| 209 | GET | `/internal/users?ids={id}` | svc:care-all | invalid X-Request-Id replaced by a generated UUID | ~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ | 4fc6bcf5-7937-411a-a364-77a557cf7217 | PASS |
| 210 | GET | `/internal/users?ids={id}` | svc:care-all | every request() call echoed its X-Request-Id (mismatches) | 0 | 0 | PASS |
| 211 | - | `-` | log | no free-text reason in the log (BR-16, ADR 0021) | 0 | 0 | PASS |
| 212 | - | `-` | log | no e-mail address in the log | 0 | 0 | PASS |
| 213 | - | `-` | log | no phone number in the log | 0 | 0 | PASS |
| 214 | - | `-` | log | no JWT-shaped string in the log | 0 | 0 | PASS |
| 215 | - | `-` | log | no Authorization/Bearer text in the log | 0 | 0 | PASS |
| 216 | - | `-` | log | status_change_actor_unknown logged for the unknown actor | yes | yes | PASS |
| 217 | - | `-` | log | user_status_changed logged | yes | yes | PASS |
| 218 | - | `-` | log | internal_contacts_read logged with counts only (requested/returned) | 1 | 1 | PASS |
| 219 | - | `-` | log | no error-level line during the run | 0 | 0 | PASS |

## Failures / notes

No real failures. Observations and discrepancies, none of which is a contract violation:

- N-1 (environment, blocks the run on the server as handed over): the server on 3000/3100 uses database
  `vcare_identity`, where migration `20261008000100` (scope `users:contact:read`, care-only `CHECK`, ADR 0024) is **not
  applied** (`npm run migrate` pending). Without it `care-service` cannot be provisioned with the contact scope, so Case 5
  cannot be exercised there; the script's preflight stops with exit 2 and says so. The shared `vcare_identity_test`
  database is truncated by concurrent Jest runs (a first run lost its fixtures mid-run), so this run used a throwaway
  database (all 10 migrations applied) and a second server instance on 3200/3300 started from the working tree
  (Redis db 2). Both were discarded afterwards; nothing was run against `vcare_identity`. Run `npm run migrate` on the
  dev database before pointing the script at 3000/3100.
- N-2 (docs drift, not the contract): spec sections 3.2 and 7 name the contacts log event `contacts_looked_up`; the code
  emits `internal_contacts_read` with `{ clientId, requested, returned }` (counts only, no address). Update the spec.
- N-3 (wording): after a suspension, a refresh with a pre-suspension cookie returns `401 RefreshTokenInvalid` (the family
  is already revoked by the status change), not `403 AccountSuspended`; spec BR-14 allows either and the script accepts
  both. Login returns `403 AccountSuspended` as specified.
- N-4 (contract note, informational): the 403 response of `internalUpdateUserStatus` references `InsufficientScope` and
  carries only a YAML comment for `Forbidden` (ADR 0025); the server returns the standard envelope with
  `error.code = Forbidden`, matching the comment and `x-error-codes`.
- N-5: `GET /internal/users` sends no `Cache-Control` header (the contract declares none); contacts is verified
  `no-store`.
- The script temporarily re-keys an existing `care-service` row (restored on exit) or creates one (soft-deleted on
  exit), because the contact scope is database-restricted to that `client_id`.
