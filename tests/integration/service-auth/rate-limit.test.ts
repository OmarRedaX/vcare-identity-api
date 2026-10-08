import type { Express } from "express";
import request from "supertest";
import { buildTestApps } from "../../helpers/app";
import { expectContractDeclares, expectErrorEnvelope } from "../../helpers/contract";
import { closeDb, truncateAll } from "../../helpers/db";
import { closeRedis, flushTestKeys } from "../../helpers/redis";
import { postToken, seedServiceClient, tokenBody } from "../../helpers/service-clients";
import { redis } from "../../../src/lib/redis/redis";

let internalApp: Express;

beforeAll(() => {
  internalApp = buildTestApps().internalApp;
  // The IP limiter keys on the client address; trusting the header lets one test act as many callers.
  internalApp.set("trust proxy", true);
});

beforeEach(async () => {
  await truncateAll();
  await flushTestKeys();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

/** Fails validation (400) before any hashing, so a limiter test is cheap, but the limiters have already run. */
function cheap(clientId: string, ip: string): request.Test {
  return postToken(internalApp, {
    grant_type: "password",
    client_id: clientId,
    client_secret: "c".repeat(43),
    scope: "users:read",
    audience: "vcare-identity",
  }).set("X-Forwarded-For", ip);
}

describe("POST /internal/auth/token: rate limits", () => {
  it("should return 429 RateLimited with Retry-After and no-store when one client_id exceeds 60 per minute", async () => {
    for (let index = 1; index <= 60; index += 1) {
      expect((await cheap("care-service", `10.1.${String(index)}.1`)).status).toBe(400);
    }

    const limited = await cheap("care-service", "10.1.99.1");

    expect(limited.status).toBe(429);
    expectErrorEnvelope(limited.body, "RateLimited");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(limited.headers["cache-control"]).toBe("no-store");
    expectContractDeclares("/internal/auth/token", "post", 429, "RateLimited");
  });

  it("should return 429 when one IP varies client_id past 30 per minute, and leave other IPs unaffected", async () => {
    for (let index = 1; index <= 30; index += 1) {
      expect((await cheap(`caller-${String(index)}`, "10.2.0.1")).status).toBe(400);
    }

    const limited = await cheap("caller-31", "10.2.0.1");
    const otherIp = await cheap("caller-31", "10.2.0.2");

    expect(limited.status).toBe(429);
    expectErrorEnvelope(limited.body, "RateLimited");
    expect(otherIp.status).toBe(400);
  });

  it("should count a garbage client_id in the shared invalid bucket and never create a Redis key from it", async () => {
    const garbage = ["", "X", "Not A Client", "a".repeat(80), "../etc/passwd"];

    for (let index = 0; index < 60; index += 1) {
      const subject = garbage[index % garbage.length] ?? "";
      expect((await cheap(subject, `10.3.${String(index)}.1`)).status).toBe(400);
    }
    const limited = await cheap("Garbage Again", "10.3.200.1");
    const validClient = await cheap("care-service", "10.3.201.1");

    expect(limited.status).toBe(429);
    expect(validClient.status).toBe(400);
    const keys = await redis.keys("rl:token-client:*");
    expect(keys.sort()).toEqual(["rl:token-client:care-service", "rl:token-client:invalid"]);
  });

  it("should not count a request toward the client limiter when the IP limiter already refused it", async () => {
    const client = await seedServiceClient();
    for (let index = 0; index < 30; index += 1) {
      await cheap("care-service", "10.4.0.1");
    }

    const refused = await postToken(internalApp, tokenBody(client)).set("X-Forwarded-For", "10.4.0.1");

    expect(refused.status).toBe(429);
    expect(await redis.zcard("rl:token-client:care-service")).toBe(30);
  });
});
