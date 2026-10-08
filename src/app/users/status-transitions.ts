import { UserStatus } from "../auth/enums";

/**
 * Domain rule 3, admin caller: `active -> suspended` and `suspended -> active`, patients only (the target
 * rules live in `UsersService`). Every other pair is `409 InvalidStatusTransition`. Pure data, no logic.
 */
export const ADMIN_TRANSITIONS: Readonly<Record<UserStatus, readonly UserStatus[]>> = {
  [UserStatus.Pending]: [],
  [UserStatus.Active]: [UserStatus.Suspended],
  [UserStatus.Suspended]: [UserStatus.Active],
  [UserStatus.Rejected]: [],
};

/**
 * Domain rule 3, service caller (`PATCH /internal/users/:id/status`, driven by Care): Case 1 (`pending -> active |
 * rejected`, `rejected -> pending`), Case 3 (`active -> suspended`) and Case 4 (`suspended -> active`, ADR 0023).
 * No target-role rules: the scoped service token is the authorization.
 */
export const SERVICE_TRANSITIONS: Readonly<Record<UserStatus, readonly UserStatus[]>> = {
  [UserStatus.Pending]: [UserStatus.Active, UserStatus.Rejected],
  [UserStatus.Active]: [UserStatus.Suspended],
  [UserStatus.Suspended]: [UserStatus.Active],
  [UserStatus.Rejected]: [UserStatus.Pending],
};
