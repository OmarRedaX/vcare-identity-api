import type { ErrorCode, ErrorDetail } from "./types";

/** Every expected failure is an AppError; only errorHandler renders it (CLAUDE.md -> API conventions). */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: readonly ErrorDetail[];
  /** When set, errorHandler emits `Retry-After` (used by the bounded hash queue; `rateLimit` sets its own). */
  readonly retryAfterSeconds?: number;

  constructor(
    code: ErrorCode,
    status: number,
    message: string,
    details: readonly ErrorDetail[] = [],
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }

  /** Returns a new instance — the shared instances in errors.ts are never mutated. */
  withDetails(details: readonly ErrorDetail[]): AppError {
    return new AppError(this.code, this.status, this.message, details, this.retryAfterSeconds);
  }

  withRetryAfter(retryAfterSeconds: number): AppError {
    return new AppError(this.code, this.status, this.message, this.details, retryAfterSeconds);
  }
}
