import { Transform } from "class-transformer";
import { IsEmail, IsIn, IsString, IsUrl, Length, Matches, MaxLength } from "class-validator";
import { IsAcceptablePassword } from "../../../lib/password/is-acceptable-password";
import {
  canonicalLocale,
  canonicalTimeZone,
  IsBcp47Locale,
  IsIanaTimeZone,
  IsNotBlank,
  MinProperties,
  trimmed,
  WhenProvided,
  WhenProvidedAndNotNull,
} from "../../../lib/validation/decorators";
import { RegistrableRole } from "../enums";

/**
 * Request DTOs (CLAUDE.md -> Module file conventions, item 2): every field has an explicit validator and
 * unknown properties are rejected by `validateBody` (`whitelist` + `forbidNonWhitelisted`), so `email`,
 * `role` and `status` on `PATCH /me` fail with `is not allowed`.
 *
 * Shapes mirror `contracts/openapi.yaml`; messages are the `issue` strings of the error envelope and never
 * echo the submitted value.
 */
const EMAIL_MAX_LENGTH = 254;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const SIX_DIGITS = /^[0-9]{6}$/;
const AVATAR_URL_MAX_LENGTH = 2048;
const TIMEZONE_MAX_LENGTH = 64;
const LOCALE_MAX_LENGTH = 35;

export class RegisterStartRequestDto {
  @IsString()
  @Transform(({ value }) => trimmed(value))
  @MaxLength(EMAIL_MAX_LENGTH)
  @IsEmail()
  email!: string;
}

export class RegisterCompleteRequestDto {
  @IsString()
  @Transform(({ value }) => trimmed(value))
  @MaxLength(EMAIL_MAX_LENGTH)
  @IsEmail()
  email!: string;

  @IsString()
  @Matches(SIX_DIGITS, { message: "must be 6 digits" })
  code!: string;

  @IsString()
  @Length(10, 128)
  @IsAcceptablePassword()
  password!: string;

  @IsString()
  @Transform(({ value }) => trimmed(value))
  @Length(1, 120)
  @IsNotBlank()
  fullName!: string;

  @IsIn([RegistrableRole.Patient, RegistrableRole.Doctor])
  role!: RegistrableRole;

  /** Optional; `null` is rejected because the contract's property is not nullable. */
  @WhenProvided()
  @IsString()
  @Matches(E164, { message: "must be an E.164 phone number" })
  phone?: string;

  @IsString()
  @Transform(({ value }) => canonicalTimeZone(value))
  @MaxLength(TIMEZONE_MAX_LENGTH)
  @IsIanaTimeZone()
  timezone!: string;

  @IsString()
  @Transform(({ value }) => canonicalLocale(value))
  @MaxLength(LOCALE_MAX_LENGTH)
  @IsBcp47Locale()
  locale!: string;
}

export class LoginRequestDto {
  @IsString()
  @Transform(({ value }) => trimmed(value))
  @MaxLength(EMAIL_MAX_LENGTH)
  @IsEmail()
  email!: string;

  /** No denylist check on login: an existing password must stay usable. */
  @IsString()
  @Length(1, 128)
  password!: string;
}

export class ForgotPasswordRequestDto {
  @IsString()
  @Transform(({ value }) => trimmed(value))
  @MaxLength(EMAIL_MAX_LENGTH)
  @IsEmail()
  email!: string;
}

export class ResetPasswordRequestDto {
  @IsString()
  @Transform(({ value }) => trimmed(value))
  @MaxLength(EMAIL_MAX_LENGTH)
  @IsEmail()
  email!: string;

  @IsString()
  @Matches(SIX_DIGITS, { message: "must be 6 digits" })
  code!: string;

  @IsString()
  @Length(10, 128)
  @IsAcceptablePassword()
  newPassword!: string;
}

export class ChangePasswordRequestDto {
  @IsString()
  @Length(1, 128)
  currentPassword!: string;

  @IsString()
  @Length(10, 128)
  @IsAcceptablePassword()
  newPassword!: string;
}

/** Only these five properties may change (BR-23); `null` clears `phone` and `avatarUrl` only. */
@MinProperties(1)
export class UpdateMeRequestDto {
  @WhenProvided()
  @IsString()
  @Transform(({ value }) => trimmed(value))
  @Length(1, 120)
  @IsNotBlank()
  fullName?: string;

  @WhenProvidedAndNotNull()
  @IsString()
  @Matches(E164, { message: "must be an E.164 phone number" })
  phone?: string | null;

  @WhenProvidedAndNotNull()
  @IsString()
  @MaxLength(AVATAR_URL_MAX_LENGTH)
  @IsUrl({ require_protocol: true, protocols: ["http", "https"], require_tld: false })
  avatarUrl?: string | null;

  @WhenProvided()
  @IsString()
  @Transform(({ value }) => canonicalTimeZone(value))
  @MaxLength(TIMEZONE_MAX_LENGTH)
  @IsIanaTimeZone()
  timezone?: string;

  @WhenProvided()
  @IsString()
  @Transform(({ value }) => canonicalLocale(value))
  @MaxLength(LOCALE_MAX_LENGTH)
  @IsBcp47Locale()
  locale?: string;
}
