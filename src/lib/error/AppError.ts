import type { ErrorCode, ErrorDetail } from "./types";

/** Every expected failure is an AppError; only errorHandler renders it (CLAUDE.md -> API conventions). */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: readonly ErrorDetail[];

  constructor(code: ErrorCode, status: number, message: string, details: readonly ErrorDetail[] = []) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** Returns a new instance — the shared instances in errors.ts are never mutated. */
  withDetails(details: readonly ErrorDetail[]): AppError {
    return new AppError(this.code, this.status, this.message, details);
  }
}
