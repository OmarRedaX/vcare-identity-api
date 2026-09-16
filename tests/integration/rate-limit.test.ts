import type { Express } from "express";
import type Redis from "ioredis";
import request from "supertest";
import { buildTestApps } from "../helpers/app";
import { expectErrorEnvelope } from "../helpers/contract";
import { closeDb } from "../helpers/db";
import { closeRedis, createUnreachableRedis, flushTestKeys } from "../helpers/redis";
import { buildTestRouter } from "../helpers/test-routers";
import { logger } from "../../src/lib/logger/logger";
import { redis } from "../../src/lib/redis/redis";

const RATE_LIMIT_KEY = "rl:test:127.0.0.1";

let apps: { publicApp: Express; internalApp: Express };
let unreachableRedis: Redis | undefined;

/**
 * These cases assert the Redis-backed path, so "Redis is connected" is a precondition, not an assumption:
 * a client that is still connecting makes the limiter degrade to the in-process fallback and the assertions
 * would describe the wrong code path.
 */
async function waitForRedisReady(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (redis.status !== "ready" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (redis.status !== "ready") {
    throw new Error(`Redis is not ready for the integration suite (status: ${redis.status})`);
  }
}

beforeAll(async () => {
  await flushTestKeys();
  await waitForRedisReady();
  apps = buildTestApps({ extraApiRouter: buildTestRouter() });
});

beforeEach(async () => {
  await flushTestKeys();
  await waitForRedisReady();
});

afterAll(async () => {
  unreachableRedis?.disconnect();
  await closeRedis();
  await closeDb();
});

describe("sliding window limiter on Redis", () => {
  it("should return 429 RateLimited with Retry-After when the limit is exceeded", async () => {
    for (let i = 0; i < 3; i += 1) {
      const allowed = await request(apps.publicApp).get("/api/__test/limited");
      expect(allowed.status).toBe(200);
    }

    const denied = await request(apps.publicApp).get("/api/__test/limited");

    expect(denied.status).toBe(429);
    expectErrorEnvelope(denied.body, "RateLimited");
    expect(Number(denied.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("should store hits under rl:test:<subject> when requests are limited", async () => {
    await request(apps.publicApp).get("/api/__test/limited");

    expect(await redis.exists(RATE_LIMIT_KEY)).toBe(1);
    expect(await redis.zcard(RATE_LIMIT_KEY)).toBe(1);
    const ttl = await redis.pttl(RATE_LIMIT_KEY);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(1000);
  });

  it("should allow again when the window has slid past the oldest hit", async () => {
    for (let i = 0; i < 3; i += 1) {
      await request(apps.publicApp).get("/api/__test/limited");
    }
    expect((await request(apps.publicApp).get("/api/__test/limited")).status).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect((await request(apps.publicApp).get("/api/__test/limited")).status).toBe(200);
  });

  it("should not record rejected attempts when the limiter denies a request", async () => {
    for (let i = 0; i < 5; i += 1) {
      await request(apps.publicApp).get("/api/__test/limited");
    }

    expect(await redis.zcard(RATE_LIMIT_KEY)).toBe(3);
  });
});

describe("Redis outage", () => {
  it("should limit at floor(limit / divisor) when Redis is unreachable and degrade is fallback", async () => {
    unreachableRedis = createUnreachableRedis();
    const { publicApp } = buildTestApps({
      extraApiRouter: buildTestRouter({ redis: unreachableRedis, logger, degrade: "fallback" }),
    });

    const first = await request(publicApp).get("/api/__test/limited");
    const second = await request(publicApp).get("/api/__test/limited");

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(await redis.exists(RATE_LIMIT_KEY)).toBe(0);
  });

  it("should allow every request when Redis is unreachable and degrade is fail-open", async () => {
    const client = createUnreachableRedis();
    try {
      const { publicApp } = buildTestApps({
        extraApiRouter: buildTestRouter({ redis: client, logger, degrade: "fail-open" }),
      });

      for (let i = 0; i < 6; i += 1) {
        const response = await request(publicApp).get("/api/__test/limited");
        expect(response.status).toBe(200);
      }
    } finally {
      client.disconnect();
    }
  });
});
