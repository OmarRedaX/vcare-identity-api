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
