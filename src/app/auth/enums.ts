/**
 * Values match the database CHECK constraints exactly (CLAUDE.md -> Module file conventions, item 9).
 * `UserRole`/`UserStatus` are asserted against `lib/rbac/types` (`Role`, `AccountStatus`) in a unit test,
 * because `lib/` cannot import `app/` (spec §3.1).
 */
export enum UserRole {
  Patient = "patient",
  Doctor = "doctor",
  Admin = "admin",
}

export enum UserStatus {
  Pending = "pending",
  Active = "active",
  Suspended = "suspended",
  Rejected = "rejected",
}

/** Registration never creates an admin (BR-4, ADR 0010). */
export enum RegistrableRole {
  Patient = "patient",
  Doctor = "doctor",
}

/** The complete set allowed by `chk_refresh_tokens_revoked_reason`. */
export enum RevokedReason {
  Rotated = "rotated",
  ReuseDetected = "reuse_detected",
  Logout = "logout",
  PasswordChanged = "password_changed",
  PasswordReset = "password_reset",
  StatusChanged = "status_changed",
  AdminRevoked = "admin_revoked",
  AccountDeleted = "account_deleted",
}
