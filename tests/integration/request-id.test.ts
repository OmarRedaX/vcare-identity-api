import type { Express } from "express";
import request from "supertest";
import { buildTestApps } from "../helpers/app";
import { closeDb } from "../helpers/db";
import { closeRedis, flushTestKeys } from "../helpers/redis";
import { buildTestRouter } from "../helpers/test-routers";
import { UUID_PATTERN } from "../../src/lib/request-id/request-id";

const INCOMING = "7F1C0A2E-1234-4ABC-8DEF-0000000000AA";

let apps: { publicApp: Express; internalApp: Express };

beforeAll(async () => {
  await flushTestKeys();
  apps = buildTestApps({
    extraApiRouter: buildTestRouter(),
    extraInternalRouter: buildTestRouter(),
  });
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("X-Request-Id", () => {
  it("should echo the incoming UUID when X-Request-Id is valid", async () => {
    const response = await request(apps.publicApp).get("/api/health/live").set("X-Request-Id", INCOMING);

    expect(response.headers["x-request-id"]).toBe(INCOMING.toLowerCase());
  });

  it("should replace X-Request-Id when it is not a UUID", async () => {
    const response = await request(apps.publicApp).get("/api/health/live").set("X-Request-Id", "not-a-uuid");

    expect(response.headers["x-request-id"]).not.toBe("not-a-uuid");
    expect(UUID_PATTERN.test(response.headers["x-request-id"] ?? "")).toBe(true);
  });

  it("should generate an id on both listeners when the header is absent", async () => {
    const publicResponse = await request(apps.publicApp).get("/api/health/live");
    const internalResponse = await request(apps.internalApp).get("/internal/health/live");

    expect(UUID_PATTERN.test(publicResponse.headers["x-request-id"] ?? "")).toBe(true);
    expect(UUID_PATTERN.test(internalResponse.headers["x-request-id"] ?? "")).toBe(true);
    expect(publicResponse.headers["x-request-id"]).not.toBe(internalResponse.headers["x-request-id"]);
  });

  it("should put the same id in the header and error body when a request fails", async () => {
    const response = await request(apps.publicApp).get("/api/__test/boom").set("X-Request-Id", INCOMING);
    const body = response.body as { error: { requestId: string } };

    expect(response.status).toBe(500);
    expect(response.headers["x-request-id"]).toBe(INCOMING.toLowerCase());
    expect(body.error.requestId).toBe(INCOMING.toLowerCase());
  });

  it("should carry the id on a 404 that never reached a route", async () => {
    const response = await request(apps.publicApp).get("/api/nothing-here");
    const body = response.body as { error: { requestId: string } };

    expect(body.error.requestId).toBe(response.headers["x-request-id"]);
  });
});
