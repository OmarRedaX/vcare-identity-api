import type { RequestHandler } from "express";
import { NotFound } from "../error/errors";

/**
 * Express answers `OPTIONS` on any known route with a bare `200 text/plain` listing the methods. Neither
 * listener serves `OPTIONS` (CORS preflights are answered earlier, in development only), so it is a 404
 * in the standard envelope instead.
 */
export function rejectOptions(): RequestHandler {
  return (req, _res, next) => {
    if (req.method === "OPTIONS") {
      next(NotFound);
      return;
    }
    next();
  };
}
