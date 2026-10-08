import type { RequestHandler } from "express";
import { SERVICE_SCOPES } from "../auth/constants";
import {
  AccountSuspended,
  Forbidden,
  InsufficientScope,
  ServiceTokenRequired,
  Unauthorized,
} from "../error/errors";
import { captureRoute } from "../http/route-capture";
import { logger as defaultLogger } from "../logger/logger";
import type { Logger } from "../logger/logger";
import type { Policy } from "./types";

/** Marks a handler as an authorization decision, so `assertRoutesAuthorized` can prove every route has one. */
export const AUTHORIZE_MARKER = Symbol.for("vcare.authorize");

/**
 * Deny by default (CLAUDE.md -> Authorization — RBAC and ownership). Every route declares a policy, public
 * ones included; a missing policy throws while the router is being built, so the process never starts.
 *
 * Ownership: `self` routes in this module take no id — the service acts only on `req.auth.userId`, so a
 * caller cannot even name another resource. `refresh-family` ownership is resolved from the database by
 * `SessionService`, which only ever touches the presented token's own family.
 */
export function authorize(policy: Policy | undefined, logger: Logger = defaultLogger): RequestHandler {
  if (policy === undefined) {
    throw new Error("route_without_policy");
  }
  if (policy.kind === "service" && !(SERVICE_SCOPES as readonly string[]).includes(policy.scope)) {
    throw new Error("policy_with_unknown_scope");
  }

  const handler: RequestHandler = (req, res, next) => {
    captureRoute(req, res);

    if (policy.kind === "public" || policy.kind === "refresh-cookie") {
      next();
      return;
    }

    const auth = req.auth;

    if (policy.kind === "service") {
      if (auth?.kind !== "service") {
        logger.info("access_denied", { reason: "unauthenticated" });
        next(ServiceTokenRequired);
        return;
      }
      if (!auth.scopes.includes(policy.scope)) {
        logger.info("access_denied", { reason: "scope" });
        next(InsufficientScope);
        return;
      }
      next();
      return;
    }

    if (auth?.kind !== "user") {
      logger.info("access_denied", { reason: "unauthenticated" });
      next(Unauthorized);
      return;
    }

    if (!policy.roles.includes(auth.role)) {
      logger.info("access_denied", { reason: "role" });
      next(Forbidden);
      return;
    }

    if (!policy.allowedStatuses.includes(auth.status)) {
      logger.info("access_denied", { reason: "status" });
      next(auth.status === "suspended" ? AccountSuspended : Forbidden);
      return;
    }

    next();
  };

  Object.defineProperty(handler, AUTHORIZE_MARKER, { value: true, enumerable: false });
  return handler;
}

export function isAuthorizeHandler(handler: unknown): boolean {
  return (
    typeof handler === "function" &&
    (handler as unknown as Record<symbol, unknown>)[AUTHORIZE_MARKER] === true
  );
}
