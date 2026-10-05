import { AppError } from "../../lib/error/AppError";

/**
 * The module's expected failures (CLAUDE.md -> Module file conventions, item 10). Messages match the
 * `contracts/openapi.yaml` examples; only `errorHandler` renders them.
 *
 * `InvalidRegistrationCode` and `InvalidResetCode` carry **one** issue string for every failure reason
 * (wrong, expired, consumed/used, superseded, never sent, missing, attempt-exhausted, and — for reset — an
 * email with no live account), so the response never reveals which (BR-3, BR-20a).
 */
export const InvalidCredentials = new AppError("InvalidCredentials", 401, "Invalid credentials");

export const RefreshTokenInvalid = new AppError(
  "RefreshTokenInvalid",
  401,
  "Refresh token is invalid",
);

export const RefreshTokenReused = new AppError(
  "RefreshTokenReused",
  401,
  "Refresh token reuse detected; session revoked",
);

export const EmailAlreadyRegistered = new AppError("Conflict", 409, "Email is already registered");

export const InvalidRegistrationCode = new AppError(
  "ValidationFailed",
  400,
  "Request validation failed",
  [{ field: "code", issue: "is invalid or expired" }],
);

export const InvalidResetCode = new AppError(
  "ValidationFailed",
  400,
  "Request validation failed",
  [{ field: "code", issue: "is invalid or expired" }],
);
