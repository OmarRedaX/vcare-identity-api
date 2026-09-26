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
import type { RateLimitDecision, RateLimitDeps, RateLimitOptions, SlidingWindowOptions } from "./types";

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

function defaultDeps(): RateLimitDeps {
  return {
    redis: defaultRedis,
    logger: defaultLogger,
    fallbackDivisor: env.RATE_LIMIT_FALLBACK_DIVISOR,
    now: () => Date.now(),
  };
}

function logDegraded(name: string, mode: string, deps: RateLimitDeps): void {
  const now = deps.now();
  const last = lastDegradeLogAt.get(name) ?? 0;
  if (now - last < DEGRADE_LOG_INTERVAL_MS) {
    return;
  }
  lastDegradeLogAt.set(name, now);
  deps.logger.warn("rate_limiter_degraded", { limiter: name, mode });
  deps.logger.metric("rate_limiter_degraded", 1, "Count", { limiter: name });
}

function degradedDecision(
  options: SlidingWindowOptions,
  key: string,
  deps: RateLimitDeps,
): RateLimitDecision {
  if (options.degrade === "fail-open") {
    logDegraded(options.name, "fail-open", deps);
    return { allowed: true, retryAfterSeconds: 0 };
  }
  logDegraded(options.name, "fallback", deps);
  return processLimiter.hit(
    key,
    fallbackLimit(options.limit, deps.fallbackDivisor),
    options.windowMs,
    deps.now(),
  );
}

/**
 * The limiter core, usable without a route (the refresh limiter's subject — the token family — is only known
 * after the database lookup, spec §4.4). Same Redis script, 50 ms budget, degrade modes, logs and metrics as
 * the middleware. Never throws; the subject is never logged (callers hash PII subjects themselves).
 */
export async function consumeRateLimit(
  options: SlidingWindowOptions,
  subject: string,
  deps?: RateLimitDeps,
): Promise<RateLimitDecision> {
  const resolved = deps ?? defaultDeps();
  const key = `rl:${options.name}:${subject}`;

  if (!isRedisReady(resolved.redis)) {
    return degradedDecision(options, key, resolved);
  }

  let reply: [number, number];
  try {
    reply = await callScript(resolved.redis, key, options.limit, options.windowMs);
  } catch {
    return degradedDecision(options, key, resolved);
  }

  const [allowed, retryAfterSeconds] = reply;
  if (allowed === 1) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  return { allowed: false, retryAfterSeconds };
}

/** Logged by both the middleware and service-side callers when a limiter denies. */
export function logRateLimited(name: string, degraded: boolean, deps?: RateLimitDeps): void {
  const resolved = deps ?? defaultDeps();
  resolved.logger.warn("rate_limited", { limiter: name, degraded });
  resolved.logger.metric("rate_limited", 1, "Count", { limiter: name });
}

/**
 * Route-level limiter (CLAUDE.md -> Security rules). Runs before validation and hashing.
 * The subject is never logged; callers hash PII subjects themselves.
 */
export function rateLimit(options: RateLimitOptions, deps?: RateLimitDeps): RequestHandler {
  const resolved: RateLimitDeps = deps ?? defaultDeps();

  return (req, res, next) => {
    captureRoute(req, res);

    consumeRateLimit(options, options.subject(req), resolved).then(
      (decision) => {
        if (decision.allowed) {
          next();
          return;
        }
        res.setHeader("Retry-After", String(Math.max(1, decision.retryAfterSeconds)));
        logRateLimited(options.name, !isRedisReady(resolved.redis), resolved);
        next(RateLimited);
      },
      () => {
        // consumeRateLimit never rejects; fail closed-shut of the limiter rather than the request.
        next();
      },
    );
  };
}
