import { Equals, IsString, Length, Matches, MaxLength } from "class-validator";
import { SERVICE_CLIENT_ID_PATTERN } from "../../../lib/auth/constants";

/**
 * Shapes mirror `contracts/openapi.yaml` -> ServiceTokenRequest. Messages are the `issue` strings of the error
 * envelope and never echo the submitted value (`client_secret` is a secret). A repeated form key arrives as an
 * array and fails `@IsString`. Wire names are snake_case (OAuth 2.0).
 */
const SCOPE_PATTERN = /^[a-z]+(:[a-z]+)+( [a-z]+(:[a-z]+)+)*$/;
const AUDIENCE_PATTERN = /^vcare-[a-z0-9-]+$/;
const SCOPE_MAX_LENGTH = 256;
const AUDIENCE_MAX_LENGTH = 64;

export class ServiceTokenRequestDto {
  @Equals("client_credentials", { message: "must be client_credentials" })
  grant_type!: string;

  @IsString()
  @Matches(SERVICE_CLIENT_ID_PATTERN, { message: "must be a valid client id" })
  client_id!: string;

  @IsString()
  @Length(32, 256, { message: "must be between 32 and 256 characters" })
  client_secret!: string;

  @IsString()
  @MaxLength(SCOPE_MAX_LENGTH)
  @Matches(SCOPE_PATTERN, { message: "must be space-separated scopes such as users:read" })
  scope!: string;

  @IsString()
  @MaxLength(AUDIENCE_MAX_LENGTH)
  @Matches(AUDIENCE_PATTERN, { message: "must be a vcare audience such as vcare-identity" })
  audience!: string;
}
