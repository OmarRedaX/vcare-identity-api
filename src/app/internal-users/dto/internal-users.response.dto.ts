import type { AccountStatus, Role } from "../../../lib/rbac/types";
import type { UserContact, UserSummary } from "../../auth/types";

/**
 * Contract `UserContact` (Case 5, ADR 0024): the only internal shape that carries an email address, and never a
 * phone. Built field by field from the narrow projection, so nothing else can leak through it.
 */
export class UserContactResponseDto {
  id: number;
  email: string;
  fullName: string;
  locale: string;
  status: AccountStatus;

  private constructor(contact: UserContact) {
    this.id = contact.id;
    this.email = contact.email;
    this.fullName = contact.fullName;
    this.locale = contact.locale;
    this.status = contact.status;
  }

  static from(contact: UserContact): UserContactResponseDto {
    return new UserContactResponseDto(contact);
  }
}

/** Contract `UserSummary` (Case 2): display profile only. Field by field, so no email or phone can leak through. */
export class UserSummaryResponseDto {
  id: number;
  fullName: string;
  avatarUrl: string | null;
  role: Role;
  status: AccountStatus;
  timezone: string;
  locale: string;

  private constructor(summary: UserSummary) {
    this.id = summary.id;
    this.fullName = summary.fullName;
    this.avatarUrl = summary.avatarUrl;
    this.role = summary.role;
    this.status = summary.status;
    this.timezone = summary.timezone;
    this.locale = summary.locale;
  }

  static from(summary: UserSummary): UserSummaryResponseDto {
    return new UserSummaryResponseDto(summary);
  }
}
