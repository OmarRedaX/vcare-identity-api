import type { Policy } from "../../lib/rbac/types";
import { UserRole, UserStatus } from "./enums";

/**
 * One policy per route (CLAUDE.md -> Authorization — RBAC and ownership); `routes.ts` passes each to
 * `authorize(...)` and the boot check proves none is missing. Roles are listed explicitly — there is no
 * "any authenticated user" wildcard (ADR 0010).
 */

/** Registration, login, the password flows, and JWKS: no principal at all. */
export const publicPolicy: Policy = { kind: "public", owner: "none" };

/**
 * Refresh and logout. The principal is the presented `vcare_rt` cookie, resolved from the database by
 * `SessionService`, which only ever acts on that token's own family — never on another user's.
 */
export const refreshFamilyPolicy: Policy = {
  kind: "refresh-cookie",
  roles: [UserRole.Patient, UserRole.Doctor, UserRole.Admin],
  owner: "refresh-family",
};

/**
 * change-password, `GET /me`, `PATCH /me`. `rejected` and `pending` accounts are allowed (ADR 0004);
 * `suspended` is refused by the claim here and again by the live row in the service (BR-24).
 */
export const selfPolicy: Policy = {
  kind: "user",
  roles: [UserRole.Patient, UserRole.Doctor, UserRole.Admin],
  owner: "self",
  allowedStatuses: [UserStatus.Pending, UserStatus.Active, UserStatus.Rejected],
};
