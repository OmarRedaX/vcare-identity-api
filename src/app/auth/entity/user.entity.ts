import type { AccountStatus, Role } from "../../../lib/rbac/types";

/**
 * The account row (CLAUDE.md -> Module file conventions, item 1): plain class, no decorators, no DB
 * knowledge. `passwordHash` never leaves a service — response DTOs do not carry it.
 */
export class User {
  id!: number;
  email!: string;
  phone!: string | null;
  passwordHash!: string;
  fullName!: string;
  avatarUrl!: string | null;
  role!: Role;
  status!: AccountStatus;
  emailVerifiedAt!: Date | null;
  timezone!: string;
  locale!: string;
  createdAt!: Date;
  updatedAt!: Date;
  deletedAt!: Date | null;

  constructor(data: Partial<User>) {
    Object.assign(this, data);
  }

  isEmailVerified(): boolean {
    return this.emailVerifiedAt !== null;
  }

  isSuspended(): boolean {
    return this.status === "suspended";
  }
}
