import "../../helpers/unreachable-redis-env";
import type { Express } from "express";
import request from "supertest";
import { buildTestApps } from "../../helpers/app";
import { expectErrorEnvelope } from "../../helpers/contract";
import { closeDb, truncateAll } from "../../helpers/db";
import { closeRedis } from "../../helpers/redis";
import { postToken, seedServiceClient, tokenBody } from "../../helpers/service-clients";

let internalApp: Express;

beforeAll(async () => {
  internalApp = buildTestApps().internalApp;
  await truncateAll();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

function cheap(): request.Test {
  return postToken(internalApp, {
    grant_type: "password",
    client_id: "care-service",
    client_secret: "c".repeat(43),
    scope: "users:read",
    audience: "vcare-identity",
  });
}

describe("POST /internal/auth/token while Redis is unreachable", () => {
  it("should keep issuing tokens under the fallback limiter and keep readiness 200 degraded", async () => {
    const client = await seedServiceClient();

    const issued = await postToken(internalApp, tokenBody(client));
    const ready = await request(internalApp).get("/internal/health/ready");

    expect(issued.status).toBe(200);
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: "degraded", checks: { database: "up", redis: "down" } });
  });

  it("should refuse requests from one IP once the fallback limiter is spent (token-ip 30 / 2 = 15 per minute)", async () => {
    // The first test already spent one of the 15. The in-process counter is per task.
    const statuses: number[] = [];
    for (let index = 0; index < 14; index += 1) {
      statuses.push((await cheap()).status);
    }
    const limited = await cheap();

    expect(statuses.every((status) => status === 400)).toBe(true);
    expect(limited.status).toBe(429);
    expectErrorEnvelope(limited.body, "RateLimited");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });
});
