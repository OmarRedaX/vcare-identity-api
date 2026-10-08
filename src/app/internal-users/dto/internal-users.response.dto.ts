import type { AccountStatus } from "../../../lib/rbac/types";
import type { UserContact } from "../../auth/types";

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
