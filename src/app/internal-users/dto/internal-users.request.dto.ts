import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { UserStatus } from "../../auth/enums";

/**
 * Request DTOs (CLAUDE.md -> Module file conventions, item 2). Unknown properties are rejected by the
 * `validate*` helpers; messages are error-envelope `issue` strings and never echo the submitted value.
 */
export const MAX_IDS = 100;
const REASON_MAX_LENGTH = 500;
const CANONICAL_ID = /^[1-9][0-9]*$/;
/** Longer than 100 canonical ids with commas can ever be; stops a giant query string being split. */
const IDS_MAX_CHARS = 2_048;
const ALL_STATUSES: readonly string[] = Object.values(UserStatus);

/** `?ids=1,2,3`: one string of canonical positive integers. A repeated `ids` key (an array) never validates. */
function parseIds({ obj, key, value }: { obj: Record<string, unknown>; key: string; value: unknown }): unknown {
  const raw = obj[key];
  if (typeof raw !== "string") return value;
  if (raw.length > IDS_MAX_CHARS) return [Number.NaN];
  return raw.split(",").map((entry) => (CANONICAL_ID.test(entry) ? Number(entry) : Number.NaN));
}

export class IdsQueryDto {
  @Transform(parseIds)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_IDS)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(Number.MAX_SAFE_INTEGER, { each: true })
  ids!: number[];
}

/** Contract `StatusChangeRequest`. Which pairs are valid is the service's transition table, not this DTO. */
export class InternalStatusChangeDto {
  @IsIn(ALL_STATUSES)
  status!: UserStatus;

  @IsString()
  @MinLength(1)
  @MaxLength(REASON_MAX_LENGTH)
  @Matches(/\S/, { message: "must not be blank" })
  reason!: string;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  actorUserId!: number;
}
