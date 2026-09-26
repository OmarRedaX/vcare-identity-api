import { AppError } from "./AppError";

/** Shared, immutable error instances. Messages match contracts/openapi.yaml examples. */
export const ValidationFailed = new AppError("ValidationFailed", 400, "Request validation failed");
export const Unauthorized = new AppError("Unauthorized", 401, "Authentication required");
export const TokenExpired = new AppError("TokenExpired", 401, "Access token expired");
export const AccountSuspended = new AppError("AccountSuspended", 403, "Account is suspended");
export const Forbidden = new AppError("Forbidden", 403, "You are not allowed to perform this action");
export const NotFound = new AppError("NotFound", 404, "Resource not found");
export const Conflict = new AppError("Conflict", 409, "Request conflicts with the current state");
export const IdempotencyConflict = new AppError(
  "IdempotencyConflict",
  422,
  "Idempotency-Key was used with a different request body",
);
export const RateLimited = new AppError("RateLimited", 429, "Too many requests");
export const InternalError = new AppError("InternalError", 500, "Internal server error");

/** A request with the same Idempotency-Key is still running (lib/idempotency). */
export const IdempotencyInProgress = new AppError(
  "Conflict",
  409,
  "A request with this Idempotency-Key is still in progress",
);
