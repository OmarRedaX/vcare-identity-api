import Redis from "ioredis";
import { env } from "../config/env";
import type { Logger } from "../logger/logger";
import type { RedisHealth } from "./types";

const ERROR_LOG_INTERVAL_MS = 10_000;
const REDIS_COMMAND_TIMEOUT_MS = 200;
const REDIS_KEEP_ALIVE_MS = 10_000;

/**
 * Redis is Tier 2 (ADR 0008): commands fail fast while disconnected and no request or readiness check
 * fails because Redis is down.
 */
export function createRedis(url: string): Redis {
  return new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    // Never replay commands whose caller already gave up (would double-count limiter hits / orphan claims).
    autoResendUnfulfilledCommands: false,
    // A connected-but-silent Redis is detected quickly instead of waiting for TCP retransmission.
    commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    keepAlive: REDIS_KEEP_ALIVE_MS,
    retryStrategy: (times: number) => Math.min(times * 200, 2000),
  });
}

export const redis: Redis = createRedis(env.REDIS_URL);

export function isRedisReady(client: Redis = redis): boolean {
  return client.status === "ready";
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("redis_timeout"));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error("redis_error"));
      },
    );
  });
}

export async function pingRedis(client: Redis, timeoutMs: number): Promise<RedisHealth> {
  if (!isRedisReady(client)) {
    return "down";
  }
  try {
    await withTimeout(client.ping(), timeoutMs);
    return "up";
  } catch {
    return "down";
  }
}

/** Connects in the background and never throws: a Redis outage must not stop the process from booting. */
export function connectRedis(client: Redis, log: Logger): void {
  let lastErrorLoggedAt = 0;

  client.on("ready", () => {
    log.info("redis_ready");
  });
  client.on("error", (err: Error) => {
    const now = Date.now();
    if (now - lastErrorLoggedAt >= ERROR_LOG_INTERVAL_MS) {
      lastErrorLoggedAt = now;
      log.warn("redis_error", { error: err.name });
    }
  });
  client.on("reconnecting", () => {
    log.debug("redis_reconnecting");
  });

  client.connect().catch((err: unknown) => {
    log.warn("redis_connect_failed", { error: err instanceof Error ? err.name : "unknown" });
  });
}
