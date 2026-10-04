import type { Logger } from "../logger/logger";

export type RedisHealth = "up" | "down";

export type BreakerState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Consecutive failures within `windowMs` that trip the breaker. */
  failureThreshold: number;
  /** A failure streak older than this restarts from one. */
  windowMs: number;
  /** How long the breaker stays open before a single probe is admitted. */
  cooldownMs: number;
}

export interface CircuitBreakerDeps {
  now: () => number;
  logger: Pick<Logger, "info" | "warn" | "metric">;
}
