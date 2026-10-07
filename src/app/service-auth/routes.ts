import express, { Router, type RequestHandler } from "express";
import type Redis from "ioredis";
import type { DependencyContainer } from "tsyringe";
import { SERVICE_CLIENT_ID_PATTERN } from "../../lib/auth/constants";
import type { Env } from "../../lib/config/types";
import { container as rootContainer } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { clientIp } from "../../lib/http/client-ip";
import { noStore } from "../../lib/http/no-store";
import { sealRouter } from "../../lib/http/route-capture";
import type { Logger } from "../../lib/logger/logger";
import { authorize } from "../../lib/rbac/authorize";
import { rateLimit } from "../../lib/rate-limit/rate-limit";
import type { RateLimitDeps, RateLimitOptions } from "../../lib/rate-limit/types";
import { toMs } from "../../pkg/utils/time";
import type { ServiceAuthController } from "./controller/service-auth.controller";
import { tokenEndpointPolicy } from "./policies";

const FORM_BODY_LIMIT = "100kb";
/** Bounds Redis key cardinality for garbage input: every malformed `client_id` shares one bucket. */
const INVALID_SUBJECT = "invalid";

function clientIdSubject(body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const clientId = (body as { client_id?: unknown }).client_id;
    if (typeof clientId === "string" && SERVICE_CLIENT_ID_PATTERN.test(clientId)) {
      return clientId;
    }
  }
  return INVALID_SUBJECT;
}

/**
 * Order (spec section 3.2): noStore -> token-ip limiter (needs no body) -> form parser -> token-client limiter
 * -> authorize(policy) -> handler. Limiters run before validation and hashing. No guard (the caller has no
 * token yet) and no idempotency (each exchange mints a new token; the header is ignored).
 */
export function buildServiceAuthRouter(scope: DependencyContainer = rootContainer): Router {
  const controller = scope.resolve<ServiceAuthController>(TOKENS.ServiceAuthController);
  const redis = scope.resolve<Redis>(TOKENS.Redis);
  const logger = scope.resolve<Logger>(TOKENS.Logger);
  const env = scope.resolve<Env>(TOKENS.Env);
  const rateDeps: RateLimitDeps = {
    redis,
    logger,
    fallbackDivisor: env.RATE_LIMIT_FALLBACK_DIVISOR,
    now: () => Date.now(),
  };
  const limiter = (options: RateLimitOptions): RequestHandler => rateLimit(options, rateDeps);

  const router = Router();

  router.use(noStore());

  router.post(
    "/token",
    limiter({
      name: "token-ip",
      limit: 30,
      windowMs: toMs(1, "m"),
      subject: (req) => clientIp(req),
      degrade: "fallback",
    }),
    express.urlencoded({ extended: false, limit: FORM_BODY_LIMIT, type: "application/x-www-form-urlencoded" }),
    limiter({
      name: "token-client",
      limit: 60,
      windowMs: toMs(1, "m"),
      subject: (req) => clientIdSubject(req.body),
      degrade: "fallback",
    }),
    authorize(tokenEndpointPolicy),
    controller.issueToken,
  );

  return sealRouter(router);
}
