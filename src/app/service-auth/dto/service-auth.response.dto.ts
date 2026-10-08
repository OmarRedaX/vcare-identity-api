import { SERVICE_TOKEN_TTL_SECONDS } from "../../../lib/auth/constants";
import type { IssueTokenResult } from "../types";

/** `contracts/openapi.yaml` -> ServiceTokenResponse. snake_case is the OAuth 2.0 wire format. */
export class ServiceTokenResponseDto {
  access_token!: string;
  token_type!: "Bearer";
  expires_in!: number;
  scope!: string;

  static from(result: IssueTokenResult): ServiceTokenResponseDto {
    const dto = new ServiceTokenResponseDto();
    dto.access_token = result.accessToken;
    dto.token_type = "Bearer";
    dto.expires_in = SERVICE_TOKEN_TTL_SECONDS;
    dto.scope = result.scope;
    return dto;
  }
}
