import express, { type ErrorRequestHandler, type Express } from "express";
import request from "supertest";
import { AppError } from "../../../../src/lib/error/AppError";
import { Logger } from "../../../../src/lib/logger/logger";
import { authorize } from "../../../../src/lib/rbac/authorize";
import type { Policy } from "../../../../src/lib/rbac/types";
import type { RequestAuth } from "../../../../src/lib/types/types";

// Express recognises an error handler by its arity, so the unused fourth parameter has to stay.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const renderError: ErrorRequestHandler = (err, _req, res, _next) => {
  const error = err as AppError;
  res.status(error.status).json({ code: error.code });
};

const READ_POLICY: Policy = { kind: "service", scope: "users:read", owner: "none" };

function appWith(policy: Policy, auth?: RequestAuth, logger?: Logger): Express {
  const app = express();
  app.get(
    "/probe",
    (req, _res, next) => {
      if (auth) {
        req.auth = auth;
      }
      next();
    },
    authorize(policy, logger),
    (_req, res) => {
      res.status(200).json({ ok: true });
    },
  );
  app.use(renderError);
  return app;
}

function sink(): { logger: Logger; lines: () => Record<string, unknown>[] } {
  const written: string[] = [];
  return {
    logger: new Logger({
      service: "identity-service",
      level: "debug",
      production: false,
      sink: (line) => {
        written.push(line);
      },
    }),
    lines: () =>
      written
        .join("")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("authorize: service policy kind", () => {
  it("should return 401 ServiceTokenRequired when there is no principal", async () => {
    const response = await request(appWith(READ_POLICY)).get("/probe");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ code: "ServiceTokenRequired" });
  });

  it("should return 401 ServiceTokenRequired when the principal is a user, whatever the role", async () => {
    for (const role of ["patient", "doctor", "admin"] as const) {
      const response = await request(
        appWith(READ_POLICY, { kind: "user", userId: 1, role, status: "active", ev: true }),
      ).get("/probe");

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ code: "ServiceTokenRequired" });
    }
  });

  it("should return 403 InsufficientScope and log reason scope when the token lacks the scope", async () => {
    const logs = sink();

    const response = await request(
      appWith(READ_POLICY, { kind: "service", clientId: "care-service", scopes: ["users:status:write"] }, logs.logger),
    ).get("/probe");

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ code: "InsufficientScope" });
    expect(logs.lines()).toContainEqual(expect.objectContaining({ message: "access_denied", reason: "scope" }));
  });

  it("should call the handler when the token carries the scope, among others", async () => {
    const response = await request(
      appWith(READ_POLICY, { kind: "service", clientId: "care-service", scopes: ["users:status:write", "users:read"] }),
    ).get("/probe");

    expect(response.status).toBe(200);
  });

  it("should throw at construction when the policy names a scope outside the vocabulary", () => {
    const unknown = { kind: "service", scope: "users:delete", owner: "none" } as unknown as Policy;

    expect(() => authorize(unknown)).toThrow("policy_with_unknown_scope");
  });
});
