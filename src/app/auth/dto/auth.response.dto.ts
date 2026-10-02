import type { AccountStatus, Role } from "../../../lib/rbac/types";
import { ACCESS_TOKEN_TTL_SECONDS } from "../../../lib/auth/constants";
import type { User } from "../entity/user.entity";

/**
 * Controllers return only these (CLAUDE.md -> Module file conventions, item 3). No response DTO carries
 * `passwordHash`, `deletedAt`, a token hash, or a one-time code; the refresh token is only ever a cookie.
 *
 * Viewer-aware rendering is not needed here: Identity holds no clinical data, and the caller is either the
 * owner (`/me`) or the anonymous registrant of this very account (`register/complete`).
 */
export class UserResponseDto {
  id: number;
  email: string;
  phone: string | null;
  fullName: string;
  avatarUrl: string | null;
  role: Role;
  status: AccountStatus;
  emailVerifiedAt: string | null;
  timezone: string;
  locale: string;
  createdAt: string;
  updatedAt: string;

  private constructor(user: User) {
    this.id = user.id;
    this.email = user.email;
    this.phone = user.phone;
    this.fullName = user.fullName;
    this.avatarUrl = user.avatarUrl;
    this.role = user.role;
    this.status = user.status;
    this.emailVerifiedAt = user.emailVerifiedAt === null ? null : user.emailVerifiedAt.toISOString();
    this.timezone = user.timezone;
    this.locale = user.locale;
    this.createdAt = user.createdAt.toISOString();
    this.updatedAt = user.updatedAt.toISOString();
  }

  static from(user: User): UserResponseDto {
    return new UserResponseDto(user);
  }
}

export class AccessTokenResponseDto {
  accessToken: string;
  tokenType = "Bearer";
  expiresIn = ACCESS_TOKEN_TTL_SECONDS;

  private constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  static from(accessToken: string): AccessTokenResponseDto {
    return new AccessTokenResponseDto(accessToken);
  }
}

/** `AccessTokenResponse` plus `user` (contract `LoginResponse`); a separate class, not a subclass, so the
 * static factory can take both arguments. */
export class LoginResponseDto {
  accessToken: string;
  tokenType = "Bearer";
  expiresIn = ACCESS_TOKEN_TTL_SECONDS;
  user: UserResponseDto;

  private constructor(accessToken: string, user: User) {
    this.accessToken = accessToken;
    this.user = UserResponseDto.from(user);
  }

  static from(accessToken: string, user: User): LoginResponseDto {
    return new LoginResponseDto(accessToken, user);
  }
}
