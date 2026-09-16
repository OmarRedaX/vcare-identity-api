import type Redis from "ioredis";
import type { Logger } from "../logger/logger";

export interface IdempotencyOptions {
  required: boolean;
}

export interface IdempotencyDeps {
  redis: Redis;
  logger: Logger;
}

export interface IdempotencyRecord {
  v: 1;
  state: "in_flight" | "completed";
  bodyHash: string;
  status?: number;
  body?: unknown;
}
