import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { type Express, Router } from "express";
import type Redis from "ioredis";
import request from "supertest";
import { buildTestApps } from "../helpers/app";
import { expectErrorEnvelope } from "../helpers/contract";
import { closeDb } from "../helpers/db";
import { closeRedis, createUnreachableRedis, flushTestKeys } from "../helpers/redis";
import { buildTestRouter, resetTestCounters, testCounters } from "../helpers/test-routers";
import { IDEMPOTENCY_TTL_MS, idempotency } from "../../src/lib/idempotency/idempotency";
import { logger } from "../../src/lib/logger/logger";
import { redis } from "../../src/lib/redis/redis";

let apps: { publicApp: Express; internalApp: Express };
let unreachableRedis: Redis | undefined;

/** The replay/conflict cases assert the Redis-backed path; a still-connecting client would skip it instead. */
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
  resetTestCounters();
  await flushTestKeys();
  await waitForRedisReady();
});

afterAll(async () => {
  unreachableRedis?.disconnect();
  await closeRedis();
  await closeDb();
});

describe("idempotent writes", () => {
  it("should replay the original status and body without re-running the handler when the same key and body repeat", async () => {
    const key = randomUUID();

    const first = await request(apps.publicApp)
      .post("/api/__test/idem")
      .set("Idempotency-Key", key)
      .send({ a: 1 });
    const second = await request(apps.publicApp)
      .post("/api/__test/idem")
      .set("Idempotency-Key", key)
      .send({ a: 1 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(testCounters.idem).toBe(1);
  });

  it("should return 422 IdempotencyConflict when the same key is reused with a different request body", async () => {
    const key = randomUUID();

    await request(apps.publicApp).post("/api/__test/idem").set("Idempotency-Key", key).send({ a: 1 });
    const conflict = await request(apps.publicApp)
      .post("/api/__test/idem")
      .set("Idempotency-Key", key)
      .send({ a: 2 });

    expect(conflict.status).toBe(422);
    expectErrorEnvelope(conflict.body, "IdempotencyConflict");
    expect(testCounters.idem).toBe(1);
  });

  it("should return 400 ValidationFailed when the key is required and missing", async () => {
    const response = await request(apps.publicApp).post("/api/__test/idem").send({ a: 1 });

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, "ValidationFailed");
    expect((response.body as { error: { details: unknown[] } }).error.details).toEqual([
      { field: "Idempotency-Key", issue: "is required" },
    ]);
    expect(testCounters.idem).toBe(0);
  });

  it("should run the handler without Redis when the key is optional and missing", async () => {
    const response = await request(apps.publicApp).post("/api/__test/idem-optional").send({ a: 1 });

    expect(response.status).toBe(201);
    expect(testCounters.idem).toBe(1);
  });

  it("should store the record under idem:POST /api/__test/idem:ip:<ip>:<key> with a TTL of at most 24 h", async () => {
    const key = randomUUID();

    await request(apps.publicApp).post("/api/__test/idem").set("Idempotency-Key", key).send({ a: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const expectedKey = `idem:POST /api/__test/idem:ip:127.0.0.1:${key}`;
    const stored = await redis.get(expectedKey);
    expect(stored).not.toBeNull();

    const record = JSON.parse(stored ?? "null") as { v: number; state: string; status: number };
    expect(record.v).toBe(1);
    expect(record.state).toBe("completed");
    expect(record.status).toBe(201);

    const ttl = await redis.pttl(expectedKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(IDEMPOTENCY_TTL_MS);
  });

  it("should not replay across resources when the same key is sent to /__test/idem/1 and /__test/idem/2", async () => {
    const key = randomUUID();

    const first = await request(apps.publicApp)
      .post("/api/__test/idem/1")
      .set("Idempotency-Key", key)
      .send({ a: 1 });
    const second = await request(apps.publicApp)
      .post("/api/__test/idem/2")
      .set("Idempotency-Key", key)
      .send({ a: 1 });

    expect((first.body as { data: { id: string } }).data.id).toBe("1");
    expect((second.body as { data: { id: string } }).data.id).toBe("2");
    expect(testCounters.idem).toBe(2);
  });

  it("should run the handler exactly once and answer the other with 409 Conflict when two requests with the same key and body race", async () => {
    const key = randomUUID();

    const [first, second] = await Promise.all([
      request(apps.publicApp)
        .post("/api/__test/idem?delayMs=300")
        .set("Idempotency-Key", key)
        .send({ a: 1 }),
      new Promise((resolve) => setTimeout(resolve, 40)).then(() =>
        request(apps.publicApp).post("/api/__test/idem?delayMs=300").set("Idempotency-Key", key).send({ a: 1 }),
      ),
    ]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    expect(testCounters.idem).toBe(1);

    const conflicting = first.status === 409 ? first : second;
    expectErrorEnvelope(conflicting.body, "Conflict");
    expect(conflicting.headers["retry-after"]).toBe("1");
  });

  it("should declare Retry-After on the contract Conflict response that carries the in-flight 409", () => {
    const contract = fs.readFileSync(path.resolve(process.cwd(), "contracts", "openapi.yaml"), "utf8");
    const start = contract.search(/^ {4}Conflict:/m);
    const block = contract.slice(start, contract.search(/^ {4}InvalidStatusTransition:/m));

    expect(block).toContain("Retry-After: { $ref: '#/components/headers/RetryAfter' }");
  });

  it("should replay the original 201 when the client disconnects mid-flight and retries with the same key and body", async () => {
    const key = randomUUID();
    const server = http.createServer(apps.publicApp);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      await new Promise<void>((resolve) => {
        const body = JSON.stringify({ a: 1 });
        const aborted = http.request(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: "/api/__test/idem?delayMs=300",
            headers: { "content-type": "application/json", "idempotency-key": key, "content-length": Buffer.byteLength(body) },
          },
          () => undefined,
        );
        aborted.on("error", () => undefined);
        aborted.write(body);
        aborted.end();
        setTimeout(() => {
          aborted.destroy();
          resolve();
        }, 80);
      });

      // While the abandoned handler is still running the key must still answer 409, not start a second run.
      const concurrent = await request(apps.publicApp)
        .post("/api/__test/idem")
        .set("Idempotency-Key", key)
        .send({ a: 1 });
      expect(concurrent.status).toBe(409);

      await new Promise((resolve) => setTimeout(resolve, 500));

      const retried = await request(apps.publicApp).post("/api/__test/idem").set("Idempotency-Key", key).send({ a: 1 });
      expect(retried.status).toBe(201);
      expect(testCounters.idem).toBe(1);
      expect((retried.body as { data: { runs: number } }).data.runs).toBe(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("should re-run the handler when the first attempt failed with 500", async () => {
    let attempts = 0;
    const router = Router();
    router.post("/__test/flaky", idempotency({ required: true }), (_req, res) => {
      attempts += 1;
      if (attempts === 1) {
        res.status(500).json({ success: false });
        return;
      }
      res.status(201).json({ success: true, data: { attempts } });
    });
    const { publicApp } = buildTestApps({ extraApiRouter: router });
    const key = randomUUID();

    const first = await request(publicApp).post("/api/__test/flaky").set("Idempotency-Key", key).send({ a: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await request(publicApp).post("/api/__test/flaky").set("Idempotency-Key", key).send({ a: 1 });

    expect(first.status).toBe(500);
    expect(second.status).toBe(201);
    expect(attempts).toBe(2);
  });

  it("should run the handler for each request when Redis is unreachable", async () => {
    unreachableRedis = createUnreachableRedis();
    const { publicApp } = buildTestApps({
      extraApiRouter: buildTestRouter({ redis: unreachableRedis, logger }),
    });
    const key = randomUUID();

    const first = await request(publicApp).post("/api/__test/idem").set("Idempotency-Key", key).send({ a: 1 });
    const second = await request(publicApp).post("/api/__test/idem").set("Idempotency-Key", key).send({ a: 1 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(testCounters.idem).toBe(2);
  });
});

describe("json body limit", () => {
  it("should return 400 ValidationFailed when the body exceeds 100kb", async () => {
    const app: Express = apps.publicApp;
    const big = { name: "x".repeat(200_000), count: 1 };

    const response = await request(app)
      .post("/api/__test/echo")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(big));

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, "ValidationFailed");
    expect((response.body as { error: { details: { issue: string }[] } }).error.details[0]?.issue).toBe(
      "must not exceed 100kb",
    );
  });
});
