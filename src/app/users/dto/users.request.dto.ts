import { Transform } from "class-transformer";
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { PaginationQueryDto } from "../../../lib/http/pagination/pagination-query.dto";
import { UserRole, UserStatus } from "../../auth/enums";

/**
 * Request DTOs (CLAUDE.md -> Module file conventions, item 2). Unknown properties are rejected by the
 * `validate*` helpers; messages are error-envelope `issue` strings and never echo the submitted value.
 */
const EMAIL_MAX_LENGTH = 254;
const REASON_MAX_LENGTH = 500;
const CANONICAL_ID = /^[1-9][0-9]*$/;
const ROLES: readonly string[] = Object.values(UserRole);
const STATUSES: readonly string[] = Object.values(UserStatus);
const ADMIN_TARGET_STATUSES: readonly string[] = [UserStatus.Active, UserStatus.Suspended];

/** Applied to every `:id` route. */
export class UserIdParamDto {
  @Transform(({ obj, key, value }: { obj: Record<string, unknown>; key: string; value: unknown }) => {
    const raw = obj[key];
    if (typeof raw === "string") return CANONICAL_ID.test(raw) ? Number(raw) : Number.NaN;
    return value;
  })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  id!: number;
}

export class ListUsersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(ROLES)
  role?: UserRole;

  @IsOptional()
  @IsIn(STATUSES)
  status?: UserStatus;

  @IsOptional()
  @IsString()
  @MaxLength(EMAIL_MAX_LENGTH)
  @IsEmail()
  email?: string;
}

/** `cursor` and `limit` only. */
export class ListSessionsQueryDto extends PaginationQueryDto {}

export class AdminStatusChangeDto {
  @IsIn(ADMIN_TARGET_STATUSES)
  status!: UserStatus;

  @IsString()
  @MinLength(1)
  @MaxLength(REASON_MAX_LENGTH)
  @Matches(/\S/, { message: "must not be blank" })
  reason!: string;
}
