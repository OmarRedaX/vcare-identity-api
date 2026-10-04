import type Redis from "ioredis";
import { env } from "../config/env";
import { logger } from "../logger/logger";
import { CircuitBreaker } from "./circuit-breaker";
import { isRedisReady, withTimeout } from "./redis";

const breakers = new WeakMap<Redis, CircuitBreaker>();

export function breakerFor(client: Redis): CircuitBreaker {
  let breaker = breakers.get(client);
  if (breaker === undefined) {
    breaker = new CircuitBreaker(
      {
        failureThreshold: env.REDIS_BREAKER_FAILURE_THRESHOLD,
        windowMs: env.REDIS_BREAKER_WINDOW_MS,
        cooldownMs: env.REDIS_BREAKER_COOLDOWN_MS,
      },
      { now: () => Date.now(), logger },
    );
    breakers.set(client, breaker);
  }
  return breaker;
}

/**
 * True when Redis may be used right now: connected AND the breaker admits the call. Callers that get `false`
 * take their documented degraded path (limiter fallback, idempotency skipped, refresh fails open).
 */
export function redisUsable(client: Redis): boolean {
  return isRedisReady(client) && breakerFor(client).allow();
}

/** `withTimeout` that reports the outcome to the client's breaker. Only timeouts and errors count as failures. */
export async function guardedRedisCall<T>(client: Redis, promise: Promise<T>, ms: number): Promise<T> {
  const breaker = breakerFor(client);
  try {
    const value = await withTimeout(promise, ms);
    breaker.recordSuccess();
    return value;
  } catch (err) {
    breaker.recordFailure();
    throw err;
  }
}
