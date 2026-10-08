import type { Policy } from "../../lib/rbac/types";

/**
 * Internal user routes are guarded by scope, with no ownership (contract: `x-roles: [service]`,
 * `x-ownership: none`). The scope is the whole authorization: `users:status:write` for the status route and
 * `users:contact:read` (care-service only, ADR 0024) for the contact lookup.
 */
export const internalStatusPolicy: Policy = { kind: "service", scope: "users:status:write", owner: "none" };
export const internalContactsPolicy: Policy = { kind: "service", scope: "users:contact:read", owner: "none" };
