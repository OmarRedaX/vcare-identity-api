import "../../helpers/saturated-hash-env";
import type { Express } from "express";
import { buildTestApps } from "../../helpers/app";
import { expectErrorEnvelope } from "../../helpers/contract";
import { closeDb, truncateAll } from "../../helpers/db";
import { closeRedis, flushTestKeys } from "../../helpers/redis";
import { postToken, seedServiceClient, tokenBody } from "../../helpers/service-clients";

let internalApp: Express;

beforeAll(async () => {
  internalApp = buildTestApps().internalApp;
  await truncateAll();
  await flushTestKeys();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("POST /internal/auth/token under hash saturation", () => {
  it("should answer 429 RateLimited with Retry-After instead of waiting when the hash queue is full", async () => {
    const client = await seedServiceClient();
    const wrong = tokenBody(client, { client_secret: "k".repeat(43) });

    const responses = await Promise.all(Array.from({ length: 6 }, () => postToken(internalApp, wrong)));

    const statuses = responses.map((response) => response.status);
    expect(statuses).toContain(401);
    expect(statuses).toContain(429);
    expect(statuses.every((status) => status === 401 || status === 429)).toBe(true);
    const refused = responses.find((response) => response.status === 429);
    expectErrorEnvelope(refused?.body, "RateLimited");
    expect(Number(refused?.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("should issue a token again when the saturating burst has drained", async () => {
    const client = await seedServiceClient({ clientId: "second-client" });

    const response = await postToken(internalApp, tokenBody(client));

    expect(response.status).toBe(200);
  });
});
