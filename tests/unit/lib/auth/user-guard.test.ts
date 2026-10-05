import express, { type ErrorRequestHandler, type Express } from "express";
import request from "supertest";
import { TokenSigner } from "../../../../src/lib/auth/jwt";
import { userGuard } from "../../../../src/lib/auth/user-guard";
import type { SigningKeySet } from "../../../../src/lib/auth/types";
import { AppError } from "../../../../src/lib/error/AppError";
import { getRequestContext, requestContext } from "../../../../src/lib/request-id/context";
import type { Clock } from "../../../../src/lib/time/types";
import { buildSigningKeySet } from "../../../helpers/keys";

const NOW = new Date("2026-09-18T10:00:00.000Z");
const clock: Clock = { now: () => NOW };

let keys: SigningKeySet;
let token: string;
let app: Express;
let contextUserId: number | undefined;

// Express recognises an error handler by its arity, so the unused fourth parameter has to stay.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const renderError: ErrorRequestHandler = (err, _req, res, _next) => {
  const error = err as AppError;
  res.status(error.status).json({ code: error.code });
};

beforeAll(async () => {
  keys = buildSigningKeySet(["kid-guard"]);
  token = await new TokenSigner(keys, clock).signUserToken({
    id: 7,
    role: "admin",
    status: "active",
    emailVerifiedAt: NOW,
  });

  app = express();
  app.use((_req, _res, next) => {
    requestContext.run({ requestId: "11111111-1111-4111-8111-111111111111" }, () => {
      next();
    });
  });
  app.get("/guarded", userGuard({ keys, clock }), (req, res) => {
    contextUserId = getRequestContext()?.userId;
    res.status(200).json(req.auth);
  });
  app.use(renderError);
});

beforeEach(() => {
  contextUserId = undefined;
});

describe("userGuard", () => {
  it("should set req.auth and the context userId when a valid bearer token is presented", async () => {
    const response = await request(app).get("/guarded").set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      kind: "user",
      userId: 7,
      role: "admin",
      status: "active",
      ev: true,
    });
    expect(contextUserId).toBe(7);
  });

  it("should accept a lower-case bearer scheme when the token is valid", async () => {
    const response = await request(app).get("/guarded").set("Authorization", `bearer ${token}`);

    expect(response.status).toBe(200);
  });

  it("should return 401 Unauthorized when the Authorization header is missing", async () => {
    const response = await request(app).get("/guarded");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ code: "Unauthorized" });
  });

  it("should return 401 Unauthorized when the scheme is not Bearer or the header is malformed", async () => {
    for (const header of [
      `Basic ${token}`,
      token,
      `Bearer  ${token}`,
      `Bearer ${token} extra`,
      "Bearer ",
    ]) {
      const response = await request(app).get("/guarded").set("Authorization", header);
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ code: "Unauthorized" });
    }
  });

  it("should return 401 TokenExpired when the token has expired", async () => {
    const expiredClock: Clock = { now: () => new Date(NOW.getTime() + 3_600_000) };
    const expiredApp = express();
    expiredApp.get("/guarded", userGuard({ keys, clock: expiredClock }), (_req, res) => {
      res.status(200).end();
    });
    expiredApp.use(renderError);

    const response = await request(expiredApp).get("/guarded").set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ code: "TokenExpired" });
  });

  it("should never read identity from caller-supplied headers when no bearer token is sent", async () => {
    const response = await request(app)
      .get("/guarded")
      .set("X-User-Id", "7")
      .set("X-Role", "admin")
      .set("X-Forwarded-User", "7");

    expect(response.status).toBe(401);
  });
});
