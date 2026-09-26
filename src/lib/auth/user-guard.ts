import type { RequestHandler } from "express";
import { Unauthorized } from "../error/errors";
import { captureRoute } from "../http/route-capture";
import { getRequestContext } from "../request-id/context";
import type { Clock } from "../time/types";
import { verifyUserAccessToken } from "./jwt";
import type { SigningKeySet } from "./types";

const BEARER = /^Bearer (\S+)$/i;

/**
 * Authentication only: verifies the bearer token and sets `req.auth` (CLAUDE.md -> Authorization:
 * guards authenticate, `authorize(policy)` authorizes). Never reads the database, and never trusts
 * `X-User-Id`, `X-Role`, or any other caller-supplied identity header.
 */
export function userGuard(deps: { keys: SigningKeySet; clock: Clock }): RequestHandler {
  return (req, res, next) => {
    captureRoute(req, res);

    const header = req.headers.authorization;
    const match = typeof header === "string" ? BEARER.exec(header) : null;
    const token = match?.[1];
    if (token === undefined) {
      next(Unauthorized);
      return;
    }

    verifyUserAccessToken(token, deps.keys, deps.clock).then(
      (auth) => {
        req.auth = auth;
        const context = getRequestContext();
        if (context) {
          context.userId = auth.userId;
        }
        next();
      },
      (err: unknown) => {
        next(err);
      },
    );
  };
}
