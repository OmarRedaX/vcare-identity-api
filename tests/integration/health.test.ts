import type { Express } from "express";
import knex, { type Knex } from "knex";
import type Redis from "ioredis";
import request from "supertest";
import { buildTestApps } from "../helpers/app";
import {
  contractErrorCodes,
  contractHealthLiveConst,
  contractOperation,
  expectErrorEnvelope,
  expectHealthStatusBody,
} from "../helpers/contract";
import { closeDb } from "../helpers/db";
import { closeRedis, createUnreachableRedis, flushTestKeys } from "../helpers/redis";
import { db } from "../../src/lib/knex/knex";
import { ERROR_CODES } from "../../src/lib/error/error-codes";
import { buildKnexConfig } from "../../src/lib/knex/knexfile";
import { Lifecycle } from "../../src/lib/lifecycle/lifecycle";

const UNREACHABLE_DATABASE_URL = "postgres://identity:identity@127.0.0.1:5999/vcare_identity_test";

let apps: { publicApp: Express; internalApp: Express };
let unreachableRedis: Redis | undefined;
let unreachableDb: Knex | undefined;

beforeAll(async () => {
  await flushTestKeys();
  apps = buildTestApps();
});

afterAll(async () => {
  unreachableRedis?.disconnect();
  if (unreachableDb) {
    await unreachableDb.destroy();
  }
  await closeRedis();
  await closeDb();
});

describe("liveness", () => {
  it("should return 200 status ok when GET /api/health/live is called", async () => {
    const response = await request(apps.publicApp).get("/api/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: contractHealthLiveConst() });
  });

  it("should return 200 status ok when GET /internal/health/live is called", async () => {
    const response = await request(apps.internalApp).get("/internal/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("should return 200 status ok when liveness is called while shutting down", async () => {
    const lifecycle = new Lifecycle();
    lifecycle.markShuttingDown();
    const { publicApp } = buildTestApps({ overrides: { lifecycle } });

    const response = await request(publicApp).get("/api/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});

describe("readiness", () => {
  it("should return 200 ok with database up and redis up when GET /api/health/ready is called", async () => {
    const response = await request(apps.publicApp).get("/api/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", checks: { database: "up", redis: "up" } });
  });

  it("should return 200 ok with database up and redis up when GET /internal/health/ready is called", async () => {
    const response = await request(apps.internalApp).get("/internal/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", checks: { database: "up", redis: "up" } });
  });

  it("should return 200 degraded with redis down when the app uses an unreachable Redis client", async () => {
    unreachableRedis = createUnreachableRedis();
    const { publicApp } = buildTestApps({ overrides: { redis: unreachableRedis } });

    const response = await request(publicApp).get("/api/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "degraded", checks: { database: "up", redis: "down" } });
  });

  it("should return 503 down when Postgres is unreachable", async () => {
    unreachableDb = knex(
      buildKnexConfig({ databaseUrl: UNREACHABLE_DATABASE_URL, poolMax: 1, statementTimeoutMs: 2000 }),
    );
    const { publicApp } = buildTestApps({ overrides: { db: unreachableDb } });

    const response = await request(publicApp).get("/api/health/ready");

    expect(response.status).toBe(503);
    const body = response.body as { status: string; checks: { database: string } };
    expect(body.status).toBe("down");
    expect(body.checks.database).toBe("down");
  });

  it("should return 503 down when readiness is called after markShuttingDown", async () => {
    const lifecycle = new Lifecycle();
    const { publicApp } = buildTestApps({ overrides: { lifecycle } });
    lifecycle.markShuttingDown();

    const response = await request(publicApp).get("/api/health/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: "down", checks: { database: "up", redis: "up" } });
  });
});

describe("readiness under pool saturation", () => {
  it("should return 200 when every request-pool connection is busy", async () => {
    const poolMax = 10;
    const busy = Array.from({ length: poolMax }, () => db.raw("SELECT pg_sleep(1.5)").catch(() => undefined));

    const response = await request(apps.publicApp).get("/api/health/ready");
    await Promise.all(busy);

    expect(response.status).toBe(200);
    expect((response.body as { checks: { database: string } }).checks.database).toBe("up");
  });
});

describe("unsupported methods", () => {
  it("should return the 404 envelope when OPTIONS is sent to a known health route on either listener", async () => {
    const publicResponse = await request(apps.publicApp).options("/api/health/live");
    const internalResponse = await request(apps.internalApp).options("/internal/health/ready");

    expect(publicResponse.status).toBe(404);
    expect(internalResponse.status).toBe(404);
    expectErrorEnvelope(publicResponse.body, "NotFound");
  });
});

describe("health contract and headers", () => {
  it("should carry X-Request-Id and Cache-Control no-store when a health route responds", async () => {
    const response = await request(apps.publicApp)
      .get("/api/health/ready")
      .set("X-Request-Id", "7f1c0a2e-1234-4abc-8def-000000000001");

    expect(response.headers["x-request-id"]).toBe("7f1c0a2e-1234-4abc-8def-000000000001");
    expect(response.headers["cache-control"]).toBe("no-store");

    const live = await request(apps.internalApp).get("/internal/health/live");
    expect(live.headers["cache-control"]).toBe("no-store");
    expect(typeof live.headers["x-request-id"]).toBe("string");
  });

  it("should match the HealthLive and HealthStatus contract schemas when health routes respond", async () => {
    const live = await request(apps.publicApp).get("/api/health/live");
    expect(live.body).toEqual({ status: contractHealthLiveConst() });

    const ready = await request(apps.publicApp).get("/api/health/ready");
    expectHealthStatusBody(ready.body, ready.status);

    const internalReady = await request(apps.internalApp).get("/internal/health/ready");
    expectHealthStatusBody(internalReady.body, internalReady.status);
  });
});

describe("listener isolation", () => {
  it("should return 404 NotFound when /internal/health/ready is requested on the public listener", async () => {
    const response = await request(apps.publicApp).get("/internal/health/ready");

    expect(response.status).toBe(404);
    expectErrorEnvelope(response.body, "NotFound");
  });

  it("should return 404 NotFound when /api/health/ready is requested on the internal listener", async () => {
    const response = await request(apps.internalApp).get("/api/health/ready");

    expect(response.status).toBe(404);
    expectErrorEnvelope(response.body, "NotFound");
  });
});

describe("health operations read from the contract", () => {
  const OPERATIONS = [
    { path: "/api/health/live", operationId: "live", internal: false },
    { path: "/api/health/ready", operationId: "ready", internal: false },
    { path: "/internal/health/live", operationId: "live", internal: true },
    { path: "/internal/health/ready", operationId: "ready", internal: true },
  ] as const;

  it("should declare 200 and 500 with InternalError on every health operation", () => {
    for (const operation of OPERATIONS) {
      const declared = contractOperation(operation.path, "get");

      expect(declared.statuses).toContain("200");
      expect(declared.statuses).toContain("500");
      expect(declared.errorCodes).toContain("InternalError");
      expect(declared.headersByStatus["200"]).toEqual(expect.arrayContaining(["X-Request-Id", "Cache-Control"]));
    }
  });

  it("should serve the declared 200 and 503 with the declared headers on both readiness operations", async () => {
    unreachableDb ??= knex(
      buildKnexConfig({ databaseUrl: UNREACHABLE_DATABASE_URL, poolMax: 1, statementTimeoutMs: 2000 }),
    );
    const down = buildTestApps({ overrides: { db: unreachableDb } });

    for (const operation of OPERATIONS.filter((entry) => entry.operationId === "ready")) {
      const declared = contractOperation(operation.path, "get");
      const healthy = operation.internal ? apps.internalApp : apps.publicApp;
      const unhealthy = operation.internal ? down.internalApp : down.publicApp;

      for (const [app, status] of [
        [healthy, 200],
        [unhealthy, 503],
      ] as const) {
        const response = await request(app).get(operation.path);

        expect(declared.statuses).toContain(String(status));
        expect(response.status).toBe(status);
        expectHealthStatusBody(response.body, status);
        for (const header of declared.headersByStatus[String(status)] ?? []) {
          expect(response.headers[header.toLowerCase()]).toBeDefined();
        }
        expect(response.headers["cache-control"]).toBe("no-store");
      }
    }
  });

  it("should list exactly the contract ErrorCode enum in the TypeScript ERROR_CODES array", () => {
    expect([...ERROR_CODES].sort()).toEqual([...contractErrorCodes()].sort());
  });
});
