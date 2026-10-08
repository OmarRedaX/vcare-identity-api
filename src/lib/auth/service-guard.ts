import type { RequestHandler } from "express";
import { ServiceTokenRequired } from "../error/errors";
import { captureRoute } from "../http/route-capture";
import { logger as defaultLogger } from "../logger/logger";
import { getRequestContext } from "../request-id/context";
import type { ServiceGuardDeps } from "./types";
import { verifyServiceAccessToken } from "./jwt";

const BEARER = /^Bearer (\S+)$/i;

/**
 * Authentication only, for `/internal/*` (CLAUDE.md -> Authentication and service-to-service auth): verifies
 * the service token's signature, issuer, expiry, `typ=service` and `aud` containing `vcare-identity`, and sets
 * `req.auth`. Performs no I/O (no database, no Redis) and never reads `X-User-Id`, `X-Role` or any other
 * caller-supplied identity header. Every failure is the same `401 ServiceTokenRequired`; the reason is only
 * logged, and the `clientId` only after the signature verified.
 */
export function serviceGuard(deps: ServiceGuardDeps): RequestHandler {
  const logger = deps.logger ?? defaultLogger;

  return (req, res, next) => {
    captureRoute(req, res);

    const header = req.headers.authorization;
    const match = typeof header === "string" ? BEARER.exec(header) : null;
    const token = match?.[1];
    if (token === undefined) {
      logger.warn("service_token_denied", { reason: "missing_token" });
      logger.metric("service_token_denied", 1, "Count", { reason: "missing_token" });
      next(ServiceTokenRequired);
      return;
    }

    verifyServiceAccessToken(token, deps.keys, deps.clock).then(
      (result) => {
        if (!result.ok) {
          logger.warn("service_token_denied", { reason: result.reason });
          logger.metric("service_token_denied", 1, "Count", { reason: result.reason });
          next(ServiceTokenRequired);
          return;
        }
        req.auth = result.auth;
        const context = getRequestContext();
        if (context) {
          context.clientId = result.auth.clientId;
        }
        next();
      },
      (err: unknown) => {
        next(err);
      },
    );
  };
}
