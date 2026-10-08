import type { AccountStatus } from "../../../lib/rbac/types";
import type { LiveFamily } from "../../auth/types";
import type { StatusChangeResult } from "../types";

/**
 * Controllers return only these (CLAUDE.md -> Module file conventions, item 3); `UserResponseDto` is reused
 * from the auth module. Never a token value, hash, token id, or user id. Not viewer-aware: no clinical data,
 * and the single viewer is an admin.
 */
export class SessionResponseDto {
  familyId: string;
  deviceInfo: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;

  private constructor(family: LiveFamily) {
    this.familyId = family.familyId;
    this.deviceInfo = family.deviceInfo;
    this.createdAt = family.createdAt.toISOString();
    this.lastUsedAt = family.lastUsedAt.toISOString();
    this.expiresAt = family.expiresAt.toISOString();
  }

  static from(family: LiveFamily): SessionResponseDto {
    return new SessionResponseDto(family);
  }
}

export class StatusChangeResponseDto {
  id: number;
  status: AccountStatus;
  updatedAt: string;

  private constructor(result: StatusChangeResult) {
    this.id = result.id;
    this.status = result.status;
    this.updatedAt = result.updatedAt.toISOString();
  }

  static from(result: StatusChangeResult): StatusChangeResponseDto {
    return new StatusChangeResponseDto(result);
  }
}
