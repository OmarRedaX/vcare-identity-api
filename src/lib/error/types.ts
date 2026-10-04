import type { ERROR_CODES } from "./error-codes";

/** The contract's ErrorCode enum (contracts/openapi.yaml -> components.schemas.ErrorCode). */
export type ErrorCode = (typeof ERROR_CODES)[number];

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
