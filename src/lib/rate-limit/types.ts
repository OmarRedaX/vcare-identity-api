import type { Request } from "express";
import type Redis from "ioredis";
import type { Logger } from "../logger/logger";

export type DegradeMode = "fallback" | "fail-open";

export interface RateLimitOptions {
  name: string;
  limit: number;
  windowMs: number;
  subject: (req: Request) => string;
  degrade: DegradeMode;
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
}
