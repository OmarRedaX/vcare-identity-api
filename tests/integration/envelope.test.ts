import type { Express } from "express";
import request from "supertest";
import { buildTestApps } from "../helpers/app";
import { expectErrorEnvelope } from "../helpers/contract";
import { closeDb } from "../helpers/db";
import { closeRedis, flushTestKeys } from "../helpers/redis";
import { buildTestRouter } from "../helpers/test-routers";

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

describe("success envelope", () => {
  it("should return the success envelope when a test route succeeds", async () => {
    const response = await request(apps.publicApp).post("/api/__test/echo").send({ name: "Fixture", count: 3 });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ success: true, data: { name: "Fixture", count: 3 } });
  });

  it("should include pagination meta when a list route responds", async () => {
    const response = await request(apps.publicApp).get("/api/__test/page?limit=2");
    const body = response.body as {
      success: boolean;
      data: { id: number }[];
      meta: { nextCursor: string | null; hasMore: boolean; count: number };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.meta.hasMore).toBe(true);
    expect(body.meta.count).toBe(2);
    expect(typeof body.meta.nextCursor).toBe("string");
  });
});

describe("error envelope", () => {
  it("should return 404 NotFound envelope with requestId when the path is unknown on either listener", async () => {
    const publicResponse = await request(apps.publicApp).get("/api/does-not-exist");
    expect(publicResponse.status).toBe(404);
    expectErrorEnvelope(publicResponse.body, "NotFound");
    expect((publicResponse.body as { error: { requestId: string } }).error.requestId).toBe(
      publicResponse.headers["x-request-id"],
    );

    const internalResponse = await request(apps.internalApp).get("/internal/does-not-exist");
    expect(internalResponse.status).toBe(404);
    expectErrorEnvelope(internalResponse.body, "NotFound");
  });

  it("should return 400 ValidationFailed on field body when the JSON is malformed", async () => {
    const response = await request(apps.publicApp)
      .post("/api/__test/echo")
      .set("Content-Type", "application/json")
      .send('{"name": "Fixture",');

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, "ValidationFailed");
    expect((response.body as { error: { details: unknown[] } }).error.details).toEqual([
      { field: "body", issue: "must be valid JSON" },
    ]);
  });

  it("should return 400 ValidationFailed with details when the DTO is invalid", async () => {
    const response = await request(apps.publicApp).post("/api/__test/echo").send({ name: 5, count: 99 });
    const body = response.body as { error: { details: { field: string; issue: string }[] } };

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, "ValidationFailed");
    expect(body.error.details.map((detail) => detail.field).sort()).toEqual(["count", "name"]);
  });

  it("should return 400 ValidationFailed when an unknown property is sent", async () => {
    const response = await request(apps.publicApp)
      .post("/api/__test/echo")
      .send({ name: "Fixture", count: 1, role: "admin" });
    const body = response.body as { error: { details: { field: string; issue: string }[] } };

    expect(response.status).toBe(400);
    expect(body.error.details).toContainEqual({ field: "role", issue: "is not allowed" });
  });

  it("should return 409 Conflict envelope when a route throws a shared AppError", async () => {
    const response = await request(apps.publicApp).get("/api/__test/app-error");

    expect(response.status).toBe(409);
    expectErrorEnvelope(response.body, "Conflict");
    expect((response.body as { error: { details: unknown[] } }).error.details).toEqual([]);
  });

  it("should return 500 InternalError without internals when a route throws an unknown error", async () => {
    const response = await request(apps.publicApp).get("/api/__test/boom");

    expect(response.status).toBe(500);
    expectErrorEnvelope(response.body, "InternalError");
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("synthetic-value");
    expect(serialized).not.toContain("password=");
    expect(serialized).not.toContain("at ");
  });
});
