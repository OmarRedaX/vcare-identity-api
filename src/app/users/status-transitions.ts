import { UserStatus } from "../auth/enums";

/**
 * Domain rule 3, admin caller: `active -> suspended` and `suspended -> active`, patients only (the target
 * rules live in `UsersService`). Every other pair is `409 InvalidStatusTransition`. Epic B adds
 * `SERVICE_TRANSITIONS` next to this constant; pure data, no logic.
 */
export const ADMIN_TRANSITIONS: Readonly<Record<UserStatus, readonly UserStatus[]>> = {
  [UserStatus.Pending]: [],
  [UserStatus.Active]: [UserStatus.Suspended],
  [UserStatus.Suspended]: [UserStatus.Active],
  [UserStatus.Rejected]: [],
};
