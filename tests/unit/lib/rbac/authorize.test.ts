import express, { type ErrorRequestHandler, type Express, Router } from "express";
import request from "supertest";
import { publicPolicy, refreshFamilyPolicy, selfPolicy } from "../../../../src/app/auth/policies";
import { AppError } from "../../../../src/lib/error/AppError";
import { Logger } from "../../../../src/lib/logger/logger";
import {
  assertRoutesAuthorized,
  markProbeExempt,
} from "../../../../src/lib/rbac/assert-routes-authorized";
import { authorize, isAuthorizeHandler } from "../../../../src/lib/rbac/authorize";
import type { Policy } from "../../../../src/lib/rbac/types";
import type { RequestAuth } from "../../../../src/lib/types/types";

// Express recognises an error handler by its arity, so the unused fourth parameter has to stay.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const renderError: ErrorRequestHandler = (err, _req, res, _next) => {
  const error = err as AppError;
  res.status(error.status).json({ code: error.code });
};

function logSink(): { logger: Logger; lines: () => Record<string, unknown>[] } {
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

describe("authorize", () => {
  it("should throw at router construction when no policy is declared", () => {
    expect(() => authorize(undefined)).toThrow("route_without_policy");
  });

  it("should mark its handler so the boot check can find it", () => {
    expect(isAuthorizeHandler(authorize(publicPolicy))).toBe(true);
    expect(isAuthorizeHandler(() => undefined)).toBe(false);
  });

  it("should allow an anonymous request when the policy is public or refresh-cookie", async () => {
    await expect(
      request(appWith(publicPolicy)).get("/probe").then((r) => r.status),
    ).resolves.toBe(200);
    await expect(
      request(appWith(refreshFamilyPolicy)).get("/probe").then((r) => r.status),
    ).resolves.toBe(200);
  });

  it("should return 401 Unauthorized when a user policy sees no principal", async () => {
    const sink = logSink();

    const response = await request(appWith(selfPolicy, undefined, sink.logger)).get("/probe");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ code: "Unauthorized" });
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "access_denied", reason: "unauthenticated" }),
    );
  });

  it("should return 401 Unauthorized when a service principal calls a user route", async () => {
    const response = await request(
      appWith(selfPolicy, { kind: "service", clientId: "care-service", scopes: ["users:read"] }),
    ).get("/probe");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ code: "Unauthorized" });
  });

  it("should return 403 Forbidden when the role is outside the policy", async () => {
    const sink = logSink();
    const doctorsOnly: Policy = {
      kind: "user",
      roles: ["doctor"],
      owner: "self",
      allowedStatuses: ["active"],
    };

    const response = await request(
      appWith(doctorsOnly, { kind: "user", userId: 1, role: "patient", status: "active", ev: true }, sink.logger),
    ).get("/probe");

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ code: "Forbidden" });
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "access_denied", reason: "role" }),
    );
  });

  it("should return 403 AccountSuspended when the claim says suspended", async () => {
    const sink = logSink();

    const response = await request(
      appWith(selfPolicy, { kind: "user", userId: 1, role: "patient", status: "suspended", ev: true }, sink.logger),
    ).get("/probe");

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ code: "AccountSuspended" });
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "access_denied", reason: "status" }),
    );
  });

  it("should return 403 Forbidden when the status is disallowed but not suspended", async () => {
    const activeOnly: Policy = {
      kind: "user",
      roles: ["patient", "doctor", "admin"],
      owner: "none",
      allowedStatuses: ["active"],
    };

    const response = await request(
      appWith(activeOnly, { kind: "user", userId: 1, role: "patient", status: "pending", ev: true }),
    ).get("/probe");

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ code: "Forbidden" });
  });

  it("should allow pending, active and rejected accounts of every role when the policy is selfPolicy", async () => {
    for (const status of ["pending", "active", "rejected"] as const) {
      for (const role of ["patient", "doctor", "admin"] as const) {
        const response = await request(
          appWith(selfPolicy, { kind: "user", userId: 1, role, status, ev: true }),
        ).get("/probe");
        expect(response.status).toBe(200);
      }
    }
  });

  it("should never log an id from the request when a decision is denied", async () => {
    const sink = logSink();

    await request(
      appWith(selfPolicy, { kind: "user", userId: 4242, role: "patient", status: "suspended", ev: true }, sink.logger),
    ).get("/probe");

    const denial = sink.lines().find((line) => line.message === "access_denied");
    expect(denial).toBeDefined();
    expect(Object.keys(denial ?? {})).toEqual(
      expect.not.arrayContaining(["userId", "email", "auth"]),
    );
  });
});

describe("assertRoutesAuthorized", () => {
  it("should accept a router whose every route carries an authorize handler", () => {
    const router = Router();
    router.get("/ok", authorize(publicPolicy), (_req, res) => {
      res.end();
    });

    expect(() => {
      assertRoutesAuthorized(router, "/api");
    }).not.toThrow();
  });

  it("should throw naming the method and path when a route has no policy", () => {
    const router = Router();
    router.post("/unguarded", (_req, res) => {
      res.end();
    });

    expect(() => {
      assertRoutesAuthorized(router, "/api");
    }).toThrow("route_without_policy: POST /api/unguarded");
  });

  it("should recurse into nested routers when a nested route has no policy", () => {
    const nested = Router();
    nested.patch("/deep", (_req, res) => {
      res.end();
    });
    const parent = Router();
    parent.use("/nested", nested);

    expect(() => {
      assertRoutesAuthorized(parent, "/api");
    }).toThrow(/route_without_policy: PATCH/);
  });

  it("should skip a router marked probe-exempt when it carries unguarded routes", () => {
    const probes = Router();
    probes.get("/live", (_req, res) => {
      res.end();
    });
    markProbeExempt(probes);
    const parent = Router();
    parent.use("/health", probes);

    expect(() => {
      assertRoutesAuthorized(parent, "/api");
    }).not.toThrow();
  });
});
