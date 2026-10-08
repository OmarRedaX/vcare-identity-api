/**
 * Token and cookie constants. These are **not** environment variables: `contracts/openapi.yaml` fixes
 * `iss`, `aud`, `expiresIn: 900` and `Max-Age=2592000`, so making them configurable could only break
 * contract conformance (spec §5.1).
 */
export const JWT_ISSUER = "vcare-identity";
export const USER_TOKEN_AUDIENCE: readonly string[] = ["vcare-identity", "vcare-care"];
export const SELF_AUDIENCE = "vcare-identity";

export const ACCESS_TOKEN_TTL_SECONDS = 900;
export const REFRESH_TOKEN_TTL_DAYS = 30;
export const REFRESH_TOKEN_TTL_SECONDS = 2_592_000;
export const CLOCK_TOLERANCE_SECONDS = 30;

export const REFRESH_COOKIE_NAME = "vcare_rt";
export const REFRESH_COOKIE_PATH = "/api/auth";

/** 32 random bytes as unpadded base64url — the shape of every refresh token this service issues. */
export const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Service tokens (client credentials, spec D-8): a constant like the user-token TTL, because the contract fixes
 * `expires_in` as `const 300`.
 */
export const SERVICE_TOKEN_TTL_SECONDS = 300;

/** The scope vocabulary. Must equal `chk_service_clients_allowed_scopes` (a unit test asserts it). */
export const SERVICE_SCOPES = [
  "users:read",
  "users:status:write",
  "doctors:read",
  "users:contact:read",
] as const;

/**
 * `users:contact:read` exposes email addresses (ADR 0024), so only this client may hold it. The database enforces
 * it (`chk_service_clients_contact_scope_care_only`); the provisioning scripts check it first for a clear error.
 */
export const CONTACT_SCOPE = "users:contact:read";
export const CONTACT_SCOPE_CLIENT_ID = "care-service";

export const SERVICE_CLIENT_ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;
