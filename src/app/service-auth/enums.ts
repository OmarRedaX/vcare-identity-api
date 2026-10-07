/**
 * Why the token endpoint refused an exchange. Logged and counted (`service_token_denied`, dimension `reason`);
 * never returned: the caller only sees `InvalidCredentials` or `InsufficientScope` (spec section 5.3).
 */
export enum TokenDenialReason {
  UnknownClient = "unknown_client",
  Inactive = "inactive",
  BadSecret = "bad_secret",
  SecretExpired = "secret_expired",
  Scope = "scope",
  Audience = "audience",
}
