import type { Policy } from "../../lib/rbac/types";
import { UserRole, UserStatus } from "../auth/enums";

/**
 * One policy for all five routes (CLAUDE.md -> Authorization — RBAC and ownership): admin only, ownership
 * `none` (an admin acts on any user; the per-target rules of the status route live in `UsersService`), and an
 * `active` account-state claim. Roles are listed explicitly (ADR 0010).
 */
export const adminUsersPolicy: Policy = {
  kind: "user",
  roles: [UserRole.Admin],
  owner: "none",
  allowedStatuses: [UserStatus.Active],
};
