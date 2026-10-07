import type { Express } from "express";
import request from "supertest";
import { buildTestApps } from "../../helpers/app";
import { seedUser, setStatus, softDelete } from "../../helpers/auth";
import { expectContractDeclares, expectErrorEnvelope } from "../../helpers/contract";
import { closeDb, truncateAll } from "../../helpers/db";
import { closeRedis, flushTestKeys } from "../../helpers/redis";
import { signAccessToken, signExpiredAccessToken, signServiceTypedToken, tamperToken } from "../../helpers/tokens";
import {
  getUser,
  historyRows,
  listSessions,
  listUsers,
  liveTokenCount,
  patchStatus,
  revokeSessions,
  seedAdmin,
  seedSession,
  userRow,
} from "../../helpers/users";

interface RouteCase {
  name: string;
  path: string;
  method: "get" | "patch" | "delete";
  allowedStatus: number;
  call: (token: string | undefined) => request.Test;
}

let apps: { publicApp: Express; internalApp: Express };
let targetId: number;
let routes: RouteCase[];

function buildRoutes(id: number): RouteCase[] {
  return [
    { name: "GET /api/users", path: "/api/users", method: "get", allowedStatus: 200, call: (token) => listUsers(apps.publicApp, token) },
    { name: "GET /api/users/:id", path: "/api/users/{id}", method: "get", allowedStatus: 200, call: (token) => getUser(apps.publicApp, token, id) },
    {
      name: "PATCH /api/users/:id/status",
      path: "/api/users/{id}/status",
      method: "patch",
      allowedStatus: 200,
      call: (token) => patchStatus(apps.publicApp, token, id, { status: "suspended", reason: "synthetic rbac check" }),
    },
    { name: "GET /api/users/:id/sessions", path: "/api/users/{id}/sessions", method: "get", allowedStatus: 200, call: (token) => listSessions(apps.publicApp, token, id) },
    { name: "DELETE /api/users/:id/sessions", path: "/api/users/{id}/sessions", method: "delete", allowedStatus: 204, call: (token) => revokeSessions(apps.publicApp, token, id) },
  ];
}

function expectDenied(
  response: request.Response,
  route: RouteCase,
  status: number,
  code: string,
): void {
  expect(response.status).toBe(status);
  expectErrorEnvelope(response.body, code);
  expectContractDeclares(route.path, route.method, status, code);
}

/** Every denied request must leave the target exactly as it was. */
async function expectTargetUntouched(): Promise<void> {
  expect((await userRow(targetId)).status).toBe("active");
  expect(await historyRows()).toHaveLength(0);
  expect(await liveTokenCount(targetId)).toBe(1);
}

beforeAll(() => {
  apps = buildTestApps();
});

beforeEach(async () => {
  await truncateAll();
  await flushTestKeys();
  const target = await seedUser({ email: "target.patient@example.test" });
  targetId = target.id;
  await seedSession(targetId);
  routes = buildRoutes(targetId);
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("users routes: authentication", () => {
  it("should answer 401 Unauthorized on every route when no bearer token is presented", async () => {
    for (const route of routes) {
      expectDenied(await route.call(undefined), route, 401, "Unauthorized");
    }
    await expectTargetUntouched();
  });

  it("should answer 401 TokenExpired on every route when the access token has expired", async () => {
    const admin = await seedAdmin();
    const expired = await signExpiredAccessToken(admin.user);

    for (const route of routes) {
      expectDenied(await route.call(expired), route, 401, "TokenExpired");
    }
    await expectTargetUntouched();
  });

  it("should answer 401 Unauthorized on every route when the signature is tampered", async () => {
    const admin = await seedAdmin();

    for (const route of routes) {
      expectDenied(await route.call(tamperToken(admin.token)), route, 401, "Unauthorized");
    }
  });

  it("should answer 401 Unauthorized on every route when a service-typed token is presented", async () => {
    const serviceToken = await signServiceTypedToken();

    for (const route of routes) {
      expectDenied(await route.call(serviceToken), route, 401, "Unauthorized");
    }
    await expectTargetUntouched();
  });

  it("should never trust identity headers when there is no bearer token", async () => {
    const admin = await seedAdmin();

    for (const route of routes) {
      const response = await route
        .call(undefined)
        .set("X-User-Id", String(admin.user.id))
        .set("X-Role", "admin")
        .set("X-Forwarded-User", String(admin.user.id));

      expectDenied(response, route, 401, "Unauthorized");
    }
    await expectTargetUntouched();
  });

  it("should not let identity headers upgrade a patient token", async () => {
    const patient = await seedUser({ email: "header.patient@example.test" });
    const token = await signAccessToken(patient);

    for (const route of routes) {
      const response = await route.call(token).set("X-User-Id", "1").set("X-Role", "admin");

      expectDenied(response, route, 403, "Forbidden");
    }
    await expectTargetUntouched();
  });
});

describe("users routes: role", () => {
  it("should answer 403 Forbidden on every route when the caller is a patient", async () => {
    const patient = await seedUser({ email: "intruder.patient@example.test" });
    const token = await signAccessToken(patient);

    for (const route of routes) {
      expectDenied(await route.call(token), route, 403, "Forbidden");
    }
    await expectTargetUntouched();
  });

  it.each(["pending", "active", "rejected"] as const)(
    "should answer 403 Forbidden on every route when the caller is a %s doctor",
    async (status) => {
      const doctor = await seedUser({ email: `intruder.${status}@example.test`, role: "doctor", status });
      const token = await signAccessToken(doctor);

      for (const route of routes) {
        expectDenied(await route.call(token), route, 403, "Forbidden");
      }
      await expectTargetUntouched();
    },
  );

  it("should answer 403 Forbidden before validating the id when a non-admin sends a malformed id", async () => {
    const patient = await seedUser({ email: "badid.patient@example.test" });

    const response = await getUser(apps.publicApp, await signAccessToken(patient), "abc");

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, "Forbidden");
  });

  it("should allow the admin on every route", async () => {
    const admin = await seedAdmin();

    for (const route of routes) {
      const response = await route.call(admin.token);

      expect(response.status).toBe(route.allowedStatus);
      expectContractDeclares(route.path, route.method, route.allowedStatus);
    }
  });
});

describe("users routes: admin account state", () => {
  it("should answer 403 AccountSuspended on every route when the admin's token claims suspended", async () => {
    const admin = await seedUser({ email: "suspended.admin@example.test", role: "admin", status: "suspended" });
    const token = await signAccessToken(admin);

    for (const route of routes) {
      expectDenied(await route.call(token), route, 403, "AccountSuspended");
    }
    await expectTargetUntouched();
  });

  it.each(["pending", "rejected"] as const)(
    "should answer 403 Forbidden on every route when the admin's token claims %s",
    async (status) => {
      const admin = await seedUser({ email: `${status}.admin@example.test`, role: "admin", status });
      const token = await signAccessToken(admin);

      for (const route of routes) {
        expectDenied(await route.call(token), route, 403, "Forbidden");
      }
      await expectTargetUntouched();
    },
  );

  it("should answer 403 AccountSuspended on the mutating routes when the admin was suspended after the token was issued (BR-2)", async () => {
    const admin = await seedAdmin();
    await setStatus(admin.user.id, "suspended");

    const status = await patchStatus(apps.publicApp, admin.token, targetId, { status: "suspended", reason: "late" });
    const revoke = await revokeSessions(apps.publicApp, admin.token, targetId);

    expect(status.status).toBe(403);
    expectErrorEnvelope(status.body, "AccountSuspended");
    expect(revoke.status).toBe(403);
    expectErrorEnvelope(revoke.body, "AccountSuspended");
    await expectTargetUntouched();
  });

  it("should answer 401 Unauthorized on the mutating routes when the admin account was deleted after the token was issued (BR-2)", async () => {
    const admin = await seedAdmin();
    await softDelete(admin.user.id);

    const status = await patchStatus(apps.publicApp, admin.token, targetId, { status: "suspended", reason: "late" });
    const revoke = await revokeSessions(apps.publicApp, admin.token, targetId);

    expect(status.status).toBe(401);
    expectErrorEnvelope(status.body, "Unauthorized");
    expect(revoke.status).toBe(401);
    expectErrorEnvelope(revoke.body, "Unauthorized");
    await expectTargetUntouched();
  });

  it("should keep serving reads on the token claim until it expires when the admin row was suspended later (accepted residual, ADR 0002)", async () => {
    const admin = await seedAdmin();
    await setStatus(admin.user.id, "suspended");

    const response = await getUser(apps.publicApp, admin.token, targetId);

    expect(response.status).toBe(200);
  });
});
