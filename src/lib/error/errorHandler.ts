import type { NextFunction, Request, Response } from "express";
import { captureRoute } from "../http/route-capture";
import { logger } from "../logger/logger";
import { AppError } from "./AppError";
import { InternalError, NotFound, ValidationFailed } from "./errors";
import type { ErrorBody, ErrorDetail } from "./types";

const BODY_LIMIT_LABEL = "100kb";

function propertyOf(err: unknown, key: string): unknown {
  if (typeof err === "object" && err !== null && key in err) {
    return (err as Record<string, unknown>)[key];
  }
  return undefined;
}

function bodyParserType(err: unknown): string | undefined {
  const type = propertyOf(err, "type");
  return typeof type === "string" ? type : undefined;
}

function clientStatus(err: unknown): number | undefined {
  for (const key of ["status", "statusCode"]) {
    const value = propertyOf(err, key);
    if (typeof value === "number" && value >= 400 && value <= 499) {
      return value;
    }
  }
  return undefined;
}

function send(res: Response, requestId: string, error: AppError, details: readonly ErrorDetail[]): void {
  const body: ErrorBody = {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      details: [...details],
      requestId,
    },
  };
  res.status(error.status).json(body);
}

/**
 * The one error envelope (CLAUDE.md -> API conventions). The body never carries a stack, SQL, driver text or
 * the message of an unknown error; the handler never logs bodies, headers, query strings or cookies.
 */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  captureRoute(req, res);
  const requestId = req.requestId;

  if (res.headersSent) {
    logger.error("response_error_after_headers", { err });
    next(err);
    return;
  }

  if (err instanceof AppError) {
    if (err.status >= 500) {
      logger.error("unhandled_error", { err });
    }
    send(res, requestId, err, err.details);
    return;
  }

  switch (bodyParserType(err)) {
    case "entity.parse.failed":
      send(res, requestId, ValidationFailed, [{ field: "body", issue: "must be valid JSON" }]);
      return;
    case "entity.too.large":
      send(res, requestId, ValidationFailed, [
        { field: "body", issue: `must not exceed ${BODY_LIMIT_LABEL}` },
      ]);
      return;
    case "encoding.unsupported":
    case "charset.unsupported":
      send(res, requestId, ValidationFailed, [{ field: "body", issue: "has an unsupported encoding" }]);
      return;
    case "request.aborted":
      logger.info("request_aborted");
      if (!res.writableEnded) {
        res.end();
      }
      return;
    default:
      break;
  }

  if (clientStatus(err) !== undefined) {
    send(res, requestId, ValidationFailed, [{ field: "body", issue: "is invalid" }]);
    return;
  }

  logger.error("unhandled_error", { err });
  send(res, requestId, InternalError, []);
}

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(NotFound);
}
