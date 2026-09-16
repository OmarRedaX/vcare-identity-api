import type { RequestHandler } from "express";

/** `Cache-Control: no-store` (CLAUDE.md -> Security rules). */
export function noStore(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  };
}
