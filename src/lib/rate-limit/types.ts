import type { Request } from "express";
import type Redis from "ioredis";
import type { Logger } from "../logger/logger";

export type DegradeMode = "fallback" | "fail-open";

/** A limiter without a subject: usable from a service through `consumeRateLimit` (spec §5.3). */
export interface SlidingWindowOptions {
  name: string;
  limit: number;
  windowMs: number;
  degrade: DegradeMode;
}

export interface RateLimitOptions extends SlidingWindowOptions {
  subject: (req: Request) => string;
}

export interface RateLimitDeps {
  redis: Redis;
  logger: Logger;
  fallbackDivisor: number;
  now: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  /** True when the in-process fallback limiter decided (Redis down or its script timed out). */
  degraded?: boolean;
}
