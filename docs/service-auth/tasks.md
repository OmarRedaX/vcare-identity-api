---
title: service-auth — Tasks
owner: identity-team
service: identity-service
module: service-auth
status: done
last_verified: 2026-10-08
tags: [tasks, service-auth, service-guard, client-credentials]
related: [service-auth-spec, service-auth-brainstorm, service-auth]
---

# service-auth — Tasks

Source: [spec.md](./spec.md) v1.1.1. Tags are the CLAUDE.md "Build order for a new module" steps.

## Legend
- [ ] todo · [~] in progress · [x] done

## Tasks
- [x] (contract) C-1 (description + InsufficientScope text) and C-2 (maxLength on scope/audience) in contracts/openapi.yaml
- [x] (migration) 20261007000300_create_service_clients: table, named CHECKs, commented partial unique index, real down
- [x] (enums-errors-types) lib/auth constants (SERVICE_TOKEN_TTL_SECONDS, SERVICE_SCOPES, SERVICE_CLIENT_ID_PATTERN), lib/error ServiceTokenRequired + InsufficientScope, service-auth enums.ts / errors.ts / types.ts
- [x] (entity) ServiceClient entity
- [x] (request-dto) ServiceTokenRequestDto
- [x] (response-dto) ServiceTokenResponseDto
- [x] (repository) service-client.repo: findLiveByClientId, touchLastUsed
- [x] (service) TokenSigner.signServiceToken + verifyServiceAccessToken, ServiceAuthService + container registration
- [x] (policies) service policy kind in lib/rbac (types + authorize) and service-auth policies.ts (tokenEndpointPolicy)
- [x] (guard) lib/auth/service-guard.ts
- [x] (controller) ServiceAuthController + container registration
- [x] (routes) routes.ts: noStore -> token-ip -> urlencoded -> token-client -> authorize -> handler
- [x] (mount) src/internal-routes.ts mounts /auth; env refinement INTERNAL_TRUST_PROXY_HOPS >= 1 in production
- [x] (scripts) provision-service-client.ts, seed-service-client.ts, service-client-args.ts, package.json scripts
- [x] (tests) unit + integration per spec section 10 (probe router via extraInternalRouter); /write-tests may extend
- [x] (manual-qa) 217 CURL checks pass, 0 fail (docs/service-auth/manual-qa.md, scripts/curl-test-service-auth.sh)
- [x] (docs) runbook, quickstart, data-model, service-auth.md, infrastructure.md, api.md, overview.md, service card, INDEX, spec v1.1.1 as-built notes (2026-10-08, /update-docs)
