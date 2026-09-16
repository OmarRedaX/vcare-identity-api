import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import type Redis from "ioredis";
import { env } from "../config/env";
import { RateLimited } from "../error/errors";
import { captureRoute } from "../http/route-capture";
import { logger as defaultLogger } from "../logger/logger";
import { isRedisReady, redis as defaultRedis, withTimeout } from "../redis/redis";
import { InProcessLimiter } from "./in-process-limiter";
import { SLIDING_WINDOW_SCRIPT } from "./sliding-window.lua";
import type { RateLimitDeps, RateLimitOptions } from "./types";

export const RATE_LIMIT_REDIS_TIMEOUT_MS = 50;

const COMMAND_NAME = "rlSlidingWindow";
const DEGRADE_LOG_INTERVAL_MS = 60_000;

const processLimiter = new InProcessLimiter();
const lastDegradeLogAt = new Map<string, number>();

export function fallbackLimit(limit: number, divisor: number): number {
  return Math.max(1, Math.floor(limit / divisor));
}

function ensureCommand(client: Redis): void {
  const commands = client as unknown as Record<string, unknown>;
  if (typeof commands[COMMAND_NAME] !== "function") {
    client.defineCommand(COMMAND_NAME, { numberOfKeys: 1, lua: SLIDING_WINDOW_SCRIPT });
  }
}

async function callScript(
  client: Redis,
  key: string,
  limit: number,
  windowMs: number,
): Promise<[number, number]> {
  ensureCommand(client);
  const command = (client as unknown as Record<string, unknown>)[COMMAND_NAME] as (
    key: string,
    limit: string,
    windowMs: string,
    member: string,
  ) => Promise<unknown>;

  const raw = await withTimeout(
    command.call(client, key, String(limit), String(windowMs), randomUUID()),
    RATE_LIMIT_REDIS_TIMEOUT_MS,
  );

  if (!Array.isArray(raw)) {
    throw new Error("rate_limit_unexpected_reply");
  }
  return [Number(raw[0]), Number(raw[1])];
}

/**
 * Route-level limiter (CLAUDE.md -> Security rules). Runs before validation and hashing.
 * The subject is never logged; callers hash PII subjects themselves.
 */
export function rateLimit(options: RateLimitOptions, deps?: RateLimitDeps): RequestHandler {
  const resolved: RateLimitDeps = deps ?? {
    redis: defaultRedis,
    logger: defaultLogger,
    fallbackDivisor: env.RATE_LIMIT_FALLBACK_DIVISOR,
    now: () => Date.now(),
  };

  const deny = (
    res: Parameters<RequestHandler>[1],
    next: Parameters<RequestHandler>[2],
    retryAfterSeconds: number,
    degraded: boolean,
  ): void => {
    res.setHeader("Retry-After", String(Math.max(1, retryAfterSeconds)));
    resolved.logger.warn("rate_limited", { limiter: options.name, degraded });
    resolved.logger.metric("rate_limited", 1, "Count", { limiter: options.name });
    next(RateLimited);
  };

  const logDegraded = (mode: string): void => {
    const now = resolved.now();
    const last = lastDegradeLogAt.get(options.name) ?? 0;
    if (now - last < DEGRADE_LOG_INTERVAL_MS) {
      return;
    }
    lastDegradeLogAt.set(options.name, now);
    resolved.logger.warn("rate_limiter_degraded", { limiter: options.name, mode });
    resolved.logger.metric("rate_limiter_degraded", 1, "Count", { limiter: options.name });
  };

  return (req, res, next) => {
    captureRoute(req, res);
    const key = `rl:${options.name}:${options.subject(req)}`;

    const degrade = (): void => {
      if (options.degrade === "fail-open") {
        logDegraded("fail-open");
        next();
        return;
      }
      logDegraded("fallback");
      const decision = processLimiter.hit(
        key,
        fallbackLimit(options.limit, resolved.fallbackDivisor),
        options.windowMs,
        resolved.now(),
      );
      if (decision.allowed) {
        next();
        return;
      }
      deny(res, next, decision.retryAfterSeconds, true);
    };

    if (!isRedisReady(resolved.redis)) {
      degrade();
      return;
    }

    callScript(resolved.redis, key, options.limit, options.windowMs).then(
      ([allowed, retryAfterSeconds]) => {
        if (allowed === 1) {
          next();
          return;
        }
        deny(res, next, retryAfterSeconds, false);
      },
      () => {
        degrade();
      },
    );
  };
}
