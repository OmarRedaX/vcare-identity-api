import express, { type Express } from "express";
import request from "supertest";
import { cors } from "../../../../src/lib/http/cors";

const ORIGIN = "http://localhost:5173";

function buildApp(): Express {
  const app = express();
  app.use(cors({ origins: [ORIGIN] }));
  app.get("/things", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.options("/things", (_req, res) => {
    res.status(200).end();
  });
  return app;
}

describe("cors", () => {
  it("should set allow-origin credentials and Vary when the origin is allowlisted", async () => {
    const response = await request(buildApp()).get("/things").set("Origin", ORIGIN);

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers["access-control-expose-headers"]).toBe("X-Request-Id, Retry-After");
    expect(response.headers.vary).toContain("Origin");
  });

  it("should set no CORS headers when the origin is not allowlisted", async () => {
    const response = await request(buildApp()).get("/things").set("Origin", "https://evil.example.test");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("should set no CORS headers when the request carries no Origin", async () => {
    const response = await request(buildApp()).get("/things");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("should answer 204 with allow-methods and allow-headers when an allowlisted preflight arrives", async () => {
    const response = await request(buildApp())
      .options("/things")
      .set("Origin", ORIGIN)
      .set("Access-Control-Request-Method", "POST");

    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-methods"]).toBe("GET, POST, PATCH, DELETE, OPTIONS");
    expect(response.headers["access-control-allow-headers"]).toBe(
      "Authorization, Content-Type, Idempotency-Key, X-Request-Id",
    );
    expect(response.headers["access-control-max-age"]).toBe("600");
  });
});
