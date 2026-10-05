import type { Express } from "express";
import request from "supertest";

// CORS is mounted by createApp only when CORS_ORIGINS is non-empty, and `env` is a module singleton read at
// import time — so the variable is set before the app wiring is required (imports are hoisted, requires are not).
process.env.CORS_ORIGINS = "http://localhost:5173";

/* eslint-disable @typescript-eslint/no-require-imports */
const { buildTestApps } = require("../helpers/app") as typeof import("../helpers/app");
const { closeDb } = require("../helpers/db") as typeof import("../helpers/db");
const { closeRedis, flushTestKeys } = require("../helpers/redis") as typeof import("../helpers/redis");
/* eslint-enable @typescript-eslint/no-require-imports */

const ORIGIN = "http://localhost:5173";

let apps: { publicApp: Express; internalApp: Express };

beforeAll(async () => {
  await flushTestKeys();
  apps = buildTestApps();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("security headers", () => {
  it("should send helmet headers and no X-Powered-By on both listeners", async () => {
    for (const [app, path] of [
      [apps.publicApp, "/api/health/live"],
      [apps.internalApp, "/internal/health/live"],
    ] as [Express, string][]) {
      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(response.headers["x-powered-by"]).toBeUndefined();
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
      expect(response.headers["x-dns-prefetch-control"]).toBe("off");
    }
  });

  it("should not send HSTS outside production when the public listener responds", async () => {
    const response = await request(apps.publicApp).get("/api/health/live");

    expect(response.headers["strict-transport-security"]).toBeUndefined();
  });
});

describe("CORS", () => {
  it("should send CORS headers when the origin is allowlisted on the public listener", async () => {
    const response = await request(apps.publicApp).get("/api/health/live").set("Origin", ORIGIN);

    expect(response.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers.vary).toContain("Origin");
  });

  it("should send no CORS headers when the origin is not allowlisted", async () => {
    const response = await request(apps.publicApp)
      .get("/api/health/live")
      .set("Origin", "https://evil.example.test");

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("should never send CORS headers on the internal listener", async () => {
    const response = await request(apps.internalApp).get("/internal/health/live").set("Origin", ORIGIN);

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});

describe("CORS preflight on /api/auth", () => {
  it("should answer a development preflight with 204 and no-store", async () => {
    const response = await request(apps.publicApp)
      .options("/api/auth/login")
      .set("Origin", ORIGIN)
      .set("Access-Control-Request-Method", "POST");

    expect(response.status).toBe(204);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["access-control-allow-origin"]).toBe(ORIGIN);
  });
});
