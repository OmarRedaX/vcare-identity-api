import type { Express } from "express";
import knex, { type Knex } from "knex";
import type Redis from "ioredis";
import request from "supertest";
import { buildTestApps } from "../../helpers/app";
import { contractOperation, expectHealthStatusBody } from "../../helpers/contract";
import { closeDb } from "../../helpers/db";
import { closeRedis, createUnreachableRedis, flushTestKeys } from "../../helpers/redis";
import { buildKnexConfig } from "../../../src/lib/knex/knexfile";

const UNREACHABLE_DATABASE_URL = "postgres://identity:identity@127.0.0.1:5999/vcare_identity_test";

let internalApp: Express;
let unreachableRedis: Redis | undefined;
let unreachableDb: Knex | undefined;

beforeAll(async () => {
  await flushTestKeys();
  internalApp = buildTestApps().internalApp;
});

afterAll(async () => {
  unreachableRedis?.disconnect();
  await unreachableDb?.destroy();
  await closeRedis();
  await closeDb();
});

describe("internal health probes (served on the internal listener)", () => {
  it("should declare both probes in the contract with the documented statuses", () => {
    expect(contractOperation("/internal/health/live", "get").statuses).toContain("200");
    expect(contractOperation("/internal/health/ready", "get").statuses).toEqual(
      expect.arrayContaining(["200", "503"]),
    );
  });

  it("should answer live 200 bare, un-enveloped and no-store when GET /internal/health/live is called", async () => {
    const response = await request(internalApp).get("/internal/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toBeDefined();
  });

  it("should answer ready 200 ok with both dependencies up when GET /internal/health/ready is called", async () => {
    const response = await request(internalApp).get("/internal/health/ready");

    expect(response.status).toBe(200);
    expectHealthStatusBody(response.body, 200);
    expect(response.body).toEqual({ status: "ok", checks: { database: "up", redis: "up" } });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("should answer ready 200 degraded when Redis is down", async () => {
    unreachableRedis = createUnreachableRedis();
    const { internalApp: degraded } = buildTestApps({ overrides: { redis: unreachableRedis } });

    const response = await request(degraded).get("/internal/health/ready");

    expect(response.status).toBe(200);
    expectHealthStatusBody(response.body, 200);
    expect(response.body).toEqual({ status: "degraded", checks: { database: "up", redis: "down" } });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("should answer ready 503 down, un-enveloped, when Postgres is unreachable", async () => {
    unreachableDb = knex(
      buildKnexConfig({ databaseUrl: UNREACHABLE_DATABASE_URL, poolMax: 1, statementTimeoutMs: 2000 }),
    );
    const { internalApp: down } = buildTestApps({ overrides: { db: unreachableDb } });

    const response = await request(down).get("/internal/health/ready");

    expect(response.status).toBe(503);
    expectHealthStatusBody(response.body, 503);
    expect(response.body).not.toHaveProperty("success");
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});
