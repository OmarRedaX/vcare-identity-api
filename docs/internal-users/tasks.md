---
title: internal-users — Tasks
owner: identity-team
service: identity-service
module: internal-users
status: in-progress
last_verified: 2026-10-08
tags: [tasks, internal-users]
related: [internal-users-spec, adr-0023-internal-status-accepts-suspended-to-active, adr-0024-notification-contacts-lookup-and-scope, adr-0025-internal-status-route-doctor-targets-only]
---

# internal-users — Tasks

## Legend
- [ ] todo · [~] in progress · [x] done

## Baseline found in the tree (verified 2026-10-08)
Already committed before this run (commits 0c9148c..6a7e5be): `users:contact:read` scope + migration `20261008000100`,
`findContactsByIds`, `AccountService.findContactsLive`, `existsIncludingDeleted`, `SERVICE_TRANSITIONS`, the service
branch of `applyStatusChange` (D-1, D-2, D-4..D-7), `GET /internal/users/contacts` and `PATCH /internal/users/:id/status`
routes, controller, request/response DTOs for them, `InternalUsersService.getContacts`, DI registration, mount.
Missing: `GET /internal/users` (Case 2) and the doctor-targets-only rule (D-3 / BR-19, ADR 0025).

## Tasks
- [x] (contract) operations + error codes in contracts/openapi.yaml (already updated: batchGetUsers, getUserContacts, internalUpdateUserStatus + Forbidden, ADR 0025)
- [x] (migration) none needed; scope migration 20261008000100 already present
- [x] (enums-errors-types) `TargetNotDoctor` error, `UserSummary`/`UserSummaryRow` types, refusal cause `role`
- [x] (entity) none (reads use narrow projections)
- [x] (request-dto) `IdsQueryDto` (renamed from `ContactsQueryDto`), `InternalStatusChangeDto`
- [x] (response-dto) `UserSummaryResponseDto`, `UserContactResponseDto`, `StatusChangeResponseDto` (reused)
- [x] (repository) `findSummariesByIds`, `findContactsByIds`, `existsIncludingDeleted`
- [x] (service) `AccountService.findSummariesLive`, `InternalUsersService.getSummaries/getContacts`, `UsersService` doctor-only rule (BR-19)
- [x] (policies) `internalBatchPolicy` (users:read), contacts, status
- [x] (controller) `batchGetUsers` handler
- [x] (routes) `GET /` added; mount already in src/internal-routes.ts
- [x] (mount) src/internal-routes.ts
- [x] (tests) unit (SERVICE_TRANSITIONS, BR-19, ids parsing, summaries) + integration batch/contacts/status/redis-down; green 2026-10-08
- [x] (manual-qa) ← /manual-qa
- [ ] (docs) service-card / api.md / service-auth.md scope table / runbook / INDEX (spec section 12.3)
