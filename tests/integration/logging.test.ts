import type { Express } from "express";
import request from "supertest";
import { buildTestApps } from "../helpers/app";
import { closeDb } from "../helpers/db";
import { captureLogs } from "../helpers/log-capture";
import { closeRedis, flushTestKeys } from "../helpers/redis";
import { buildTestRouter } from "../helpers/test-routers";
import { logger } from "../../src/lib/logger/logger";

const FIXTURES = {
  authorization: "Bearer fixture-access-token-value",
  cookie: "vcare_rt=fixture-refresh-token-value",
  password: "fixture-password-value",
  email: "person@example.test",
  fullName: "Fixture Person",
};

let apps: { publicApp: Express; internalApp: Express };

beforeAll(async () => {
  await flushTestKeys();
  apps = buildTestApps({ extraApiRouter: buildTestRouter() });
});

afterAll(async () => {
  logger.setLevel("warn");
  await closeRedis();
  await closeDb();
});

describe("request logging", () => {
  it("should contain no fixture secret values in captured logs when requests carry Authorization and Cookie headers and a body with password and email", async () => {
    const capture = captureLogs();
    try {
      await request(apps.publicApp)
        .post("/api/__test/echo")
        .set("Authorization", FIXTURES.authorization)
        .set("Cookie", FIXTURES.cookie)
        .send({ name: "Fixture", count: 1, password: FIXTURES.password, email: FIXTURES.email });

      await request(apps.publicApp)
        .get("/api/__test/boom")
        .set("Authorization", FIXTURES.authorization)
        .set("Cookie", FIXTURES.cookie);

      const text = capture.text();
      expect(text).not.toContain("fixture-access-token-value");
      expect(text).not.toContain("fixture-refresh-token-value");
      expect(text).not.toContain(FIXTURES.password);
      expect(text).not.toContain(FIXTURES.email);
      expect(text).not.toContain(FIXTURES.fullName);
    } finally {
      capture.restore();
    }
  });

  it("should log request_completed with the route pattern when a test route responds", async () => {
    const capture = captureLogs();
    try {
      await request(apps.publicApp).post("/api/__test/echo").send({ name: "Fixture", count: 1 });

      const line = capture
        .lines()
        .find((entry) => entry.message === "request_completed" && entry.route === "/api/__test/echo");

      expect(line).toBeDefined();
      expect(line?.method).toBe("POST");
      expect(line?.status).toBe(201);
      expect(typeof line?.durationMs).toBe("number");
      expect(typeof line?.requestId).toBe("string");
    } finally {
      capture.restore();
    }
  });

  it("should not log health probes when they succeed", async () => {
    const capture = captureLogs();
    try {
      await request(apps.publicApp).get("/api/health/ready");

      const health = capture
        .lines()
        .filter((entry) => entry.message === "request_completed" && String(entry.route).includes("/health/"));

      expect(health).toHaveLength(0);
    } finally {
      capture.restore();
    }
  });

  it("should log request_completed at error level when a route fails", async () => {
    const capture = captureLogs();
    try {
      await request(apps.publicApp).get("/api/__test/boom");

      const line = capture
        .lines()
        .find((entry) => entry.message === "request_completed" && entry.status === 500);

      expect(line?.level).toBe("error");
      expect(line?.route).toBe("/api/__test/boom");
    } finally {
      capture.restore();
    }
  });
});
