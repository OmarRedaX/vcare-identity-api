# vcare-identity-api — Identity & Access Service

Part of the **[Vcare Virtual Care Platform](https://github.com/OmarRedaX/Vcare)** — start there for the
PRD, architecture, service catalog, and cross-service contracts.

Owns **who someone is and whether they may act**: accounts, authentication, short-lived access tokens with
rotating refresh tokens, sessions, email verification, password management, account status, and service
tokens for service-to-service auth.

> Status: design only — the AI/Claude setup and docs exist; no application code yet.

| Read | For |
|---|---|
| [CLAUDE.md](./CLAUDE.md) | binding rules: stack, layering, security, domain rules, workflow |
| [docs/INDEX.md](./docs/INDEX.md) | service docs router (architecture, runbook, quickstart, ADRs) |
| [contracts/openapi.yaml](./contracts/openapi.yaml) | the HTTP API — source of truth |

**Related repos:** [Vcare (docs hub)](https://github.com/OmarRedaX/Vcare) ·
[vcare-care-api](https://github.com/OmarRedaX/vcare-care-api)
