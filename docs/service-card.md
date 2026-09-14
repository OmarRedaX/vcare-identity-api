---
title: Identity Service — Service Card
owner: identity-team
service: identity-service
status: draft
last_verified: 2026-09-14
tags: [service-card, catalog, identity]
related: [index, system-design, runbook, data-model, api]
sync_to_hub: catalog/identity-service.card.md
---

# Service Card — identity-service

> The cross-cutting summary that `../vcare-hub/scripts/sync-from-spoke.sh` copies to
> `catalog/identity-service.card.md` in the hub. Keep it short and current; never hand-copy it into the hub.

| Field | Value |
|---|---|
| **Name** | identity-service |
| **Repo** | `vcare-identity-api` |
| **Owner** | identity-team |
| **Status** | design (no code yet) |
| **Tier** | 1 — if it is down, nobody can log in or refresh |
| **Runtime** | Node.js 24 LTS + TypeScript, Express 5; two listeners (public `PORT` 3000, internal `INTERNAL_PORT` 3100) |
| **Datastores** | PostgreSQL (own identity database), Redis (rate limits, idempotency keys) |

## Responsibilities
Owns **who someone is and whether they may act**: accounts, registration, login/logout, EdDSA access
tokens and rotating refresh tokens (sessions), email verification, password reset and change, account
status (`pending`, `active`, `suspended`, `rejected`) with history, and service clients / service tokens
for service-to-service auth. Publishes JWKS so consumers verify tokens locally. Never owns doctor
profiles, credentials, verification documents, or any clinical data (care-service).

## Data owned
`users`, `refresh_tokens`, `password_resets`, `email_verifications`, `service_clients`,
`user_status_changes`. See [architecture/data-model.md](./architecture/data-model.md).

## Depends on
| Kind | Target | For | Sync? |
|---|---|---|---|
| — | none | Identity makes **no synchronous calls** to other vcare services | — |
| provider (async) | email provider | verification and password-reset emails, queued outside the request; failure never fails the request | async |

## Called by
| Caller | Endpoint | Why | Failure policy (caller side) |
|---|---|---|---|
| care-service | `PATCH /internal/users/{id}/status` | Case 1 — verification decision activates or rejects a doctor account; `pending` when Care re-opens a rejected application | retry on timeout/5xx; `409 InvalidStatusTransition` is non-retryable |
| care-service | `PATCH /internal/users/{id}/status` | Case 3 — suspension revokes all sessions | must not degrade: retry until success + alert; `409` (target not `active`) → alert, no retry |
| care-service | `GET /internal/users?ids=` | Case 2 — batch profile hydration (≤ 100 ids) | degrade to cached profiles |
| care-service | `POST /internal/auth/token` | obtain a 300 s service token | — |
| care-service, web clients | `GET /.well-known/jwks.json` | verify user access tokens locally | cache keys 5 min |
| ai-service (Phase 2, future) | `POST /internal/auth/token` | token issuance for a new service client with its own scopes (first holder of `doctors:read`, which no MVP client holds) | — |
| web clients | `/api/auth/*`, `/api/users/*` | end-user auth and admin user management | — |

## Endpoint families
| Family | Paths | Listener |
|---|---|---|
| auth | `/api/auth/register`, `login`, `refresh`, `logout`, `verify-email`, `resend-verification`, `forgot-password`, `reset-password`, `change-password`, `me` | public |
| users (admin) | `/api/users`, `/api/users/{id}`, `/api/users/{id}/status`, `/api/users/{id}/sessions` | public |
| keys | `/.well-known/jwks.json` | public |
| service-auth | `/internal/auth/token` | internal |
| internal-users | `/internal/users`, `/internal/users/{id}/status` | internal |
| health | `/api/health`, `/internal/health` | both |

## Events
None in MVP (HTTP-only). Future: `user.registered`, `user.status_changed` — see
[architecture/future.md](./architecture/future.md).

## Contracts
- HTTP: [`contracts/openapi.yaml`](../contracts/openapi.yaml) (source of truth; public + internal)

## Key links
- Docs index: [INDEX.md](./INDEX.md)
- System design: [system-design.md](./system-design.md)
- Runbook: [runbook.md](./runbook.md)
