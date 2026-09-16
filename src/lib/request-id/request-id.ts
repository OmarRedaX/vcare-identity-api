import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { requestContext } from "./context";

export const REQUEST_ID_HEADER = "X-Request-Id";
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * First middleware on both apps, so every response — including 404, 400 and 500 — carries the header
 * (CLAUDE.md -> API conventions).
 */
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.headers["x-request-id"];
    const id =
      typeof incoming === "string" && UUID_PATTERN.test(incoming) ? incoming.toLowerCase() : randomUUID();

    req.requestId = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    requestContext.run({ requestId: id }, next);
  };
}
