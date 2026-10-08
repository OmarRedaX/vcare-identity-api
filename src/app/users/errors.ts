import { AppError } from "../../lib/error/AppError";

/**
 * The module's expected failures (CLAUDE.md -> Module file conventions, item 10). All reuse existing error
 * codes; `NotFound`, `Unauthorized` and `AccountSuspended` come from `lib/error/errors`. The three 403s are
 * distinct messages under one code and carry no user data.
 */
export const TargetIsSelf = new AppError(
  "Forbidden",
  403,
  "You cannot change your own account status",
);

export const TargetIsAdmin = new AppError(
  "Forbidden",
  403,
  "You cannot change another admin's account status",
);

export const TargetIsDoctor = new AppError(
  "Forbidden",
  403,
  "Doctor account status is managed by care-service",
);

/** ADR 0025: the internal status route changes doctor accounts only. */
export const TargetNotDoctor = new AppError(
  "Forbidden",
  403,
  "Only doctor account status can be changed through this route",
);

export const InvalidStatusTransition = new AppError(
  "InvalidStatusTransition",
  409,
  "Status change is not allowed",
);
