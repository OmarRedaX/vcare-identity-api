import type { AccountStatus, Role } from "../../lib/rbac/types";
import type { RevokedReason, UserStatus } from "./enums";
import type { User } from "./entity/user.entity";

/**
 * Every non-entity type of the module (CLAUDE.md -> Module file conventions, item 11).
 * Nothing here carries a plaintext secret except the inputs the service receives from a DTO.
 */

// ── database rows (BIGINT arrives from `pg` as a string) ──
export interface UserRow {
  id: string | number;
  email: string;
  phone: string | null;
  password_hash: string;
  full_name: string;
  avatar_url: string | null;
  role: string;
  status: string;
  email_verified_at: Date | null;
  timezone: string;
  locale: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface RefreshTokenRow {
  id: string | number;
  user_id: string | number;
  family_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: string | null;
  replaced_by_id: string | number | null;
  device_info: string | null;
  created_at: Date;
}

export interface PasswordResetRow {
  id: string | number;
  user_id: string | number;
  code_hash: string | null;
  attempts: number;
  expires_at: Date | null;
  used_at: Date | null;
  invalidated_at: Date | null;
  created_at: Date;
}

export interface RegistrationChallengeRow {
  id: string | number;
  email: string;
  code_hash: string | null;
  attempts: number;
  expires_at: Date | null;
  consumed_at: Date | null;
  invalidated_at: Date | null;
  created_at: Date;
}

/** `users` list row: the cursor value is the microsecond-precision text of `created_at` (spec §3.7). */
export interface UserListRow extends UserRow {
  created_at_cursor: string;
}

/** One live refresh-token family joined to its earliest retained token (spec §3.7). */
export interface LiveFamilyRow {
  family_id: string;
  device_info: string | null;
  last_used_at: Date;
  expires_at: Date;
  first_created_at: Date;
  first_created_at_cursor: string;
}

// ── insert shapes ──
export interface NewUserRow {
  email: string;
  phone: string | null;
  passwordHash: string;
  fullName: string;
  role: Role;
  status: UserStatus;
  timezone: string;
  locale: string;
}

export interface NewRefreshTokenRow {
  userId: number;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  deviceInfo: string | null;
}

// ── service inputs and results ──
export interface RegisterCompleteInput {
  email: string;
  code: string;
  password: string;
  fullName: string;
  role: Role;
  phone: string | undefined;
  timezone: string;
  locale: string;
}

export interface LoginInput {
  email: string;
  password: string;
  userAgent: string | undefined;
}

export interface LoginResult {
  user: User;
  accessToken: string;
  refreshToken: string;
}

/** The refresh decision table (spec §4.4); the controller maps each kind to a status and cookie action. */
export type RefreshOutcome =
  | { kind: "rotated"; accessToken: string; refreshToken: string }
  | { kind: "grace" }
  | { kind: "invalid" }
  | { kind: "reused" }
  | { kind: "suspended" }
  | { kind: "rate_limited"; retryAfterSeconds: number };

export interface ResetPasswordInput {
  email: string;
  code: string;
  newPassword: string;
}

export interface ChangePasswordInput {
  userId: number;
  currentPassword: string;
  newPassword: string;
  presentedRefreshToken: string | undefined;
}

/** `undefined` = leave unchanged; `null` = clear (phone, avatarUrl only). */
export interface UpdateProfileInput {
  fullName?: string;
  phone?: string | null;
  avatarUrl?: string | null;
  timezone?: string;
  locale?: string;
}

/** One indistinguishable failure path per outcome that is not `match` (BR-3, BR-20a). */
export type ChallengeCheck =
  | "no_challenge"
  | "not_sent"
  | "expired"
  | "mismatch"
  | "exhausted"
  | "match";

/** `no_reset` also covers an unknown email, so reset cannot be used to enumerate accounts. */
export type ResetCheck = "no_reset" | "not_sent" | "expired" | "mismatch" | "exhausted" | "match";

export interface PurgeResult {
  table: string;
  deleted: number;
}

export interface RevocationSummary {
  revoked: number;
  keptFamilyId: string | undefined;
}

export type RevocationReason = RevokedReason;

export interface AccountStatusView {
  status: AccountStatus;
}

/** Pure email content (subject + body text), built by `jobs/email-templates.ts`. */
export interface EmailTemplate {
  subject: string;
  text: string;
}

// ── admin list shapes (used by the `users` module through `AccountService` / `SessionService`) ──
export interface UserListFilter {
  role?: Role;
  status?: AccountStatus;
  email?: string;
}

/** `createdAt` is the microsecond-precision ISO text carried by the cursor. */
export interface UserListCursor {
  createdAt: string;
  id: number;
}

export interface UserListItem {
  user: User;
  createdAtCursor: string;
}

export interface LiveFamily {
  familyId: string;
  deviceInfo: string | null;
  /** Earliest retained token of the family. */
  createdAt: Date;
  createdAtCursor: string;
  lastUsedAt: Date;
  expiresAt: Date;
}

export interface LiveFamilyCursor {
  createdAt: string;
  familyId: string;
}
