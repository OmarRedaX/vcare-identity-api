import type { RequestHandler } from "express";
import type { CorsOptions } from "./types";

const ALLOW_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
const ALLOW_HEADERS = "Authorization, Content-Type, Idempotency-Key, X-Request-Id";
const EXPOSE_HEADERS = "X-Request-Id, Retry-After";
const MAX_AGE_SECONDS = "600";

/**
 * In-house allowlist CORS (ADR 0015): development only, public listener only — production is a single
 * origin with CORS disabled (hub ADR 0005).
 */
export function cors(options: CorsOptions): RequestHandler {
  const allowed = new Set(options.origins);

  return (req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin !== "string" || !allowed.has(origin)) {
      next();
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Expose-Headers", EXPOSE_HEADERS);
    res.appendHeader("Vary", "Origin");

    if (req.method === "OPTIONS" && typeof req.headers["access-control-request-method"] === "string") {
      res.setHeader("Access-Control-Allow-Methods", ALLOW_METHODS);
      res.setHeader("Access-Control-Allow-Headers", ALLOW_HEADERS);
      res.setHeader("Access-Control-Max-Age", MAX_AGE_SECONDS);
      res.status(204).end();
      return;
    }

    next();
  };
}
