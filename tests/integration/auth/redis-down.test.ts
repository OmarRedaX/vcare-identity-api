import "../../helpers/unreachable-redis-env";
import type { Express } from "express";
import request from "supertest";
import { buildTestApps } from "../../helpers/app";
import { cookieFor, refreshTokenFrom, seedUser, TEST_PASSWORD } from "../../helpers/auth";
import { expectErrorEnvelope } from "../../helpers/contract";
import { closeDb, truncateAll } from "../../helpers/db";
import { closeRedis } from "../../helpers/redis";

let apps: { publicApp: Express; internalApp: Express };

beforeAll(async () => {
  apps = buildTestApps();
  await truncateAll();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("credential routes while Redis is unreachable", () => {
  it("should keep logging in under the in-process fallback limiter and keep readiness 200 when Redis is down", async () => {
    const user = await seedUser({ email: "fallback.login@example.test" });
    const attempt = (): Promise<request.Response> =>
      request(apps.publicApp).post("/api/auth/login").send({ email: user.email, password: TEST_PASSWORD });

    // login-ip-email is 5 per minute; with Redis down it degrades to max(1, floor(5 / 2)) = 2 per task.
    const first = await attempt();
    const second = await attempt();
    const third = await attempt();
    const ready = await request(apps.publicApp).get("/api/health/ready");

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(third.status).toBe(429);
    expectErrorEnvelope(third.body, "RateLimited");
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: "degraded", checks: { redis: "down" } });
  });

  it("should still log in, refresh and log out when Redis is down, because refresh fails open", async () => {
    const user = await seedUser({ email: "redisless.session@example.test" });
    const loggedIn = await request(apps.publicApp)
      .post("/api/auth/login")
      .send({ email: user.email, password: TEST_PASSWORD });

    const refreshed = await request(apps.publicApp)
      .post("/api/auth/refresh")
      .set("Cookie", cookieFor(refreshTokenFrom(loggedIn) ?? ""));
    const loggedOut = await request(apps.publicApp)
      .post("/api/auth/logout")
      .set("Cookie", cookieFor(refreshTokenFrom(refreshed) ?? ""));

    expect(loggedIn.status).toBe(200);
    expect(refreshed.status).toBe(200);
    expect(loggedOut.status).toBe(204);
  });
});
