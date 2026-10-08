import type { Policy } from "../../lib/rbac/types";

/**
 * The token endpoint has no guard: the caller has no token yet, and its principal is the client credentials in
 * the body, checked by `ServiceAuthService`. The `public` kind still gives the route an `authorize(...)`, so
 * the boot check proves every internal route has a policy. Contract: `x-roles: [service]`, `x-ownership: none`.
 * Guarded internal routes (later modules) use `{ kind: "service", scope, owner: "none" }`.
 */
export const tokenEndpointPolicy: Policy = { kind: "public", owner: "none" };
