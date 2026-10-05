import { Router, type RequestHandler } from "express";
import type Redis from "ioredis";
import type { DependencyContainer } from "tsyringe";
import { userGuard } from "../../lib/auth/user-guard";
import type { SigningKeySet } from "../../lib/auth/types";
import { container as rootContainer } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import type { Env } from "../../lib/config/types";
import { clientIp } from "../../lib/http/client-ip";
import { noStore } from "../../lib/http/no-store";
import { sealRouter } from "../../lib/http/route-capture";
import { idempotency } from "../../lib/idempotency/idempotency";
import type { IdempotencyOptions } from "../../lib/idempotency/types";
import type { Logger } from "../../lib/logger/logger";
import { authorize } from "../../lib/rbac/authorize";
import { rateLimit } from "../../lib/rate-limit/rate-limit";
import type { RateLimitDeps, RateLimitOptions } from "../../lib/rate-limit/types";
import type { Clock } from "../../lib/time/types";
import { sha256Hex } from "../../pkg/utils/crypto";
import { toMs } from "../../pkg/utils/time";
import type { AuthController } from "./controller/auth.controller";
import type { JwksController } from "./controller/jwks.controller";
import { publicPolicy, refreshFamilyPolicy, selfPolicy } from "./policies";

/**
 * Per-route order (spec §4.1): rateLimit -> userGuard -> authorize(policy) -> per-user rateLimit ->
 * idempotency -> handler. Limiters on public routes run **before** validation and hashing
 * (CLAUDE.md -> Security rules), and every route declares a policy — the boot check proves it (BR-27).
 *
 * Login mounts **no** idempotency middleware (D-1): an `Idempotency-Key` header is ignored, never stored
 * and never replayed, so no access token can be written to Redis.
 */

/** Subjects are hashed here: the limiter never sees or logs an email address. */
function emailHashSubject(body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const email = (body as { email?: unknown }).email;
    if (typeof email === "string") {
      return sha256Hex(email.trim().toLowerCase());
    }
  }
  return "invalid";
}

export function buildAuthRouter(scope: DependencyContainer = rootContainer): Router {
  const controller = scope.resolve<AuthController>(TOKENS.AuthController);
  const keys = scope.resolve<SigningKeySet>(TOKENS.SigningKeys);
  const clock = scope.resolve<Clock>(TOKENS.Clock);
  const guard = userGuard({ keys, clock });

  // The same Redis and Logger the services use (bootstrap overrides included), not the process globals.
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
  const idem = (options: IdempotencyOptions): RequestHandler => idempotency(options, { redis, logger });

  const router = Router();

  // Every /api/auth response — success, error, 429, and an unmatched /api/auth path — is non-cacheable.
  router.use(noStore());

  router.post(
    "/register/start",
    limiter({
      name: "register-start-email",
      limit: 3,
      windowMs: toMs(1, "h"),
      subject: (req) => emailHashSubject(req.body),
      degrade: "fallback",
    }),
    limiter({
      name: "register-start-ip",
      limit: 5,
      windowMs: toMs(1, "h"),
      subject: (req) => clientIp(req),
      degrade: "fallback",
    }),
    authorize(publicPolicy),
    idem({ required: false }),
    controller.startRegistration,
  );

  router.post(
    "/register/complete",
    limiter({
      name: "register-complete-ip",
      limit: 10,
      windowMs: toMs(1, "h"),
      subject: (req) => clientIp(req),
      degrade: "fallback",
    }),
    authorize(publicPolicy),
    idem({ required: true }),
    controller.completeRegistration,
  );

  router.post(
    "/login",
    limiter({
      name: "login-ip-email",
      limit: 5,
      windowMs: toMs(1, "m"),
      subject: (req) => `${clientIp(req)}:${emailHashSubject(req.body)}`,
      degrade: "fallback",
    }),
    limiter({
      name: "login-ip",
      limit: 20,
      windowMs: toMs(1, "m"),
      subject: (req) => clientIp(req),
      degrade: "fallback",
    }),
    authorize(publicPolicy),
    controller.login,
  );

  // The refresh limiter's subject is the token family, so it runs inside SessionService (spec §4.4).
  router.post("/refresh", authorize(refreshFamilyPolicy), controller.refresh);

  router.post("/logout", authorize(refreshFamilyPolicy), controller.logout);

  router.post(
    "/forgot-password",
    limiter({
      name: "forgot-email",
      limit: 3,
      windowMs: toMs(1, "h"),
      subject: (req) => emailHashSubject(req.body),
      degrade: "fallback",
    }),
    authorize(publicPolicy),
    idem({ required: false }),
    controller.forgotPassword,
  );

  router.post(
    "/reset-password",
    // Per-email first: it bounds a distributed guessing attack on one account to the 5 tries the row
    // itself allows (ADR 0017).
    limiter({
      name: "reset-email",
      limit: 5,
      windowMs: toMs(1, "h"),
      subject: (req) => emailHashSubject(req.body),
      degrade: "fallback",
    }),
    limiter({
      name: "reset-ip",
      limit: 10,
      windowMs: toMs(1, "h"),
      subject: (req) => clientIp(req),
      degrade: "fallback",
    }),
    authorize(publicPolicy),
    idem({ required: false }),
    controller.resetPassword,
  );

  router.post(
    "/change-password",
    guard,
    authorize(selfPolicy),
    // Subject is the authenticated user id, so the limiter must run after the guard (D-2).
    limiter({
      name: "change-password-user",
      limit: 5,
      windowMs: toMs(15, "m"),
      subject: (req) => (req.auth?.kind === "user" ? String(req.auth.userId) : "anonymous"),
      degrade: "fallback",
    }),
    idem({ required: false }),
    controller.changePassword,
  );

  router.get("/me", guard, authorize(selfPolicy), controller.getMe);
  router.patch("/me", guard, authorize(selfPolicy), controller.updateMe);

  return sealRouter(router);
}

/**
 * Mounted at `/.well-known` on the public listener, outside `/api` and outside `noStore()`: the JWK Set is
 * deliberately cacheable for 5 minutes.
 */
export function buildWellKnownRouter(scope: DependencyContainer = rootContainer): Router {
  const controller = scope.resolve<JwksController>(TOKENS.JwksController);
  const router = Router();
  router.get("/jwks.json", authorize(publicPolicy), controller.jwks);
  return sealRouter(router);
}
