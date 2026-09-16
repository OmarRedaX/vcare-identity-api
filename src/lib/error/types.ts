/** The contract's ErrorCode enum (contracts/openapi.yaml -> components.schemas.ErrorCode). */
export type ErrorCode =
  | "ValidationFailed"
  | "Unauthorized"
  | "TokenExpired"
  | "InvalidCredentials"
  | "RefreshTokenInvalid"
  | "RefreshTokenReused"
  | "EmailNotVerified"
  | "AccountPending"
  | "AccountSuspended"
  | "AccountRejected"
  | "Forbidden"
  | "ServiceTokenRequired"
  | "InsufficientScope"
  | "NotFound"
  | "Conflict"
  | "InvalidStatusTransition"
  | "IdempotencyConflict"
  | "RateLimited"
  | "InternalError";

export interface ErrorDetail {
  field: string;
  issue: string;
}

export interface ErrorBody {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details: ErrorDetail[];
    requestId: string;
  };
}
