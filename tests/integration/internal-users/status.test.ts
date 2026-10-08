import type { Express } from "express";
import request from "supertest";
import { db } from "../../../src/lib/knex/knex";
import { buildTestApps } from "../../helpers/app";
import {
  cookieFor,
  seedUser,
  setStatus,
  softDelete,
  TEST_PASSWORD,
  uuid,
} from "../../helpers/auth";
import {
  expectContractDeclares,
  expectErrorEnvelope,
  expectStatusChangePayload,
  expectSuccessEnvelope,
} from "../../helpers/contract";
import { closeDb, truncateAll } from "../../helpers/db";
import { captureLogs } from "../../helpers/log-capture";
import { closeRedis, flushTestKeys } from "../../helpers/redis";
import { signAccessToken, signCustomServiceToken } from "../../helpers/tokens";
import {
  historyRows,
  liveTokenCount,
  patchStatus,
  seedAdmin,
  seedSession,
  tokenRows,
  userRow,
  type Admin,
} from "../../helpers/users";

const REASON = "Synthetic reason: credentials reviewed by an administrator";
const ACTOR_ID = 7;

let apps: { publicApp: Express; internalApp: Express };
let writeToken: string;
let admin: Admin;

function internalPatch(
  id: number | string,
  body: unknown,
  token: string | null = writeToken,
  headers: Record<string, string> = {},
): request.Test {
  const call = request(apps.internalApp).patch(`/internal/users/${String(id)}/status`);
  if (token !== null) {
    void call.set("Authorization", `Bearer ${token}`);
  }
  for (const [name, value] of Object.entries(headers)) {
    void call.set(name, value);
  }
  return call.send(body as object);
}

function change(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { status, reason: REASON, actorUserId: ACTOR_ID, ...extra };
}

beforeAll(async () => {
  apps = buildTestApps();
  writeToken = await signCustomServiceToken({ scope: "users:status:write", subject: "care-service" });
});

beforeEach(async () => {
  await truncateAll();
  await flushTestKeys();
  admin = await seedAdmin();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

async function doctorWithStatus(status: "pending" | "active" | "suspended" | "rejected", email: string) {
  return seedUser({ email, role: "doctor", status });
}

describe("PATCH /internal/users/:id/status: Case 4 reinstatement (suspended -> active)", () => {
  it("should reinstate a suspended doctor, return the contract's StatusChangeResponse and record one history row", async () => {
    const doctor = await doctorWithStatus("suspended", "reinstate.doctor@example.test");
    const actor = await seedUser({ email: "reinstating.admin@example.test", role: "admin" });
    const requestId = uuid();
    const before = await userRow(doctor.id);

    const response = await internalPatch(doctor.id, change("active", { actorUserId: actor.id }), writeToken, {
      "X-Request-Id": requestId,
    });

    expect(response.status).toBe(200);
    expectContractDeclares("/internal/users/{id}/status", "patch", 200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toBe(requestId);
    const payload = expectStatusChangePayload(expectSuccessEnvelope(response.body));
    expect(payload).toMatchObject({ id: doctor.id, status: "active" });

    const after = await userRow(doctor.id);
    expect(after.status).toBe("active");
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());

    const rows = await historyRows(doctor.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      from_status: "suspended",
      to_status: "active",
      actor_user_id: String(actor.id),
      actor_service: "care-service",
      reason: REASON,
      request_id: requestId,
    });
  });

  it("should return 200 with no new history row and an unchanged updated_at when the doctor is already active", async () => {
    const doctor = await doctorWithStatus("suspended", "retry.doctor@example.test");
    await internalPatch(doctor.id, change("active")).expect(200);
    const afterFirst = await userRow(doctor.id);

    const second = await internalPatch(doctor.id, change("active"));

    expect(second.status).toBe(200);
    expect(expectStatusChangePayload(expectSuccessEnvelope(second.body))).toMatchObject({ status: "active" });
    expect((await userRow(doctor.id)).updated_at.getTime()).toBe(afterFirst.updated_at.getTime());
    expect(await historyRows(doctor.id)).toHaveLength(1);
  });

  it("should not resurrect refresh tokens revoked at suspension, and let the doctor sign in again", async () => {
    const doctor = await doctorWithStatus("active", "revived.doctor@example.test");
    const session = await seedSession(doctor.id);
    await internalPatch(doctor.id, change("suspended")).expect(200);
    expect(await liveTokenCount(doctor.id)).toBe(0);

    await internalPatch(doctor.id, change("active")).expect(200);

    expect(await liveTokenCount(doctor.id)).toBe(0);
    const revoked = (await tokenRows(doctor.id)).filter((row) => row.revoked_at !== null);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.revoked_reason).toBe("status_changed");

    const refresh = await request(apps.publicApp).post("/api/auth/refresh").set("Cookie", cookieFor(session.token));
    expect(refresh.status).toBe(401);
    expectErrorEnvelope(refresh.body, "RefreshTokenInvalid");

    const login = await request(apps.publicApp)
      .post("/api/auth/login")
      .send({ email: "revived.doctor@example.test", password: TEST_PASSWORD });
    expect(login.status).toBe(200);
  });

  it("should keep the public admin route refusing a doctor target after the change", async () => {
    const doctor = await doctorWithStatus("suspended", "still.refused@example.test");

    const response = await patchStatus(apps.publicApp, admin.token, doctor.id, { status: "active", reason: REASON });

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, "Forbidden");
    expect((await userRow(doctor.id)).status).toBe("suspended");
    expect(await historyRows(doctor.id)).toHaveLength(0);
  });

  it("should still let an admin reinstate a suspended patient through the public route", async () => {
    const patient = await seedUser({ email: "patient.reinstated@example.test", status: "suspended" });

    const response = await patchStatus(apps.publicApp, admin.token, patient.id, { status: "active", reason: REASON });

    expect(response.status).toBe(200);
    expect((await userRow(patient.id)).status).toBe("active");
  });
});

describe("PATCH /internal/users/:id/status: Cases 1 and 3", () => {
  it.each([
    ["pending", "active"],
    ["pending", "rejected"],
    ["rejected", "pending"],
    ["active", "suspended"],
  ] as const)("should apply %s to %s and write one history row", async (from, to) => {
    const doctor = await doctorWithStatus(from, `${from}.${to}@example.test`);

    const response = await internalPatch(doctor.id, change(to));

    expect(response.status).toBe(200);
    expect((await userRow(doctor.id)).status).toBe(to);
    const rows = await historyRows(doctor.id);
    expect(rows.map((row) => `${row.from_status}->${row.to_status}`)).toEqual([`${from}->${to}`]);
  });

  it("should revoke every refresh family in the same transaction when suspending", async () => {
    const doctor = await doctorWithStatus("active", "suspend.sessions@example.test");
    await seedSession(doctor.id);
    await seedSession(doctor.id);
    expect(await liveTokenCount(doctor.id)).toBe(2);

    const response = await internalPatch(doctor.id, change("suspended"));

    expect(response.status).toBe(200);
    expect(await liveTokenCount(doctor.id)).toBe(0);
  });

  it("should revoke every refresh family when Care rejects a pending doctor, who can still sign in (ADR 0004)", async () => {
    const doctor = await doctorWithStatus("pending", "reject.sessions@example.test");
    await seedSession(doctor.id);

    await internalPatch(doctor.id, change("rejected")).expect(200);

    expect(await liveTokenCount(doctor.id)).toBe(0);
    const login = await request(apps.publicApp)
      .post("/api/auth/login")
      .send({ email: "reject.sessions@example.test", password: TEST_PASSWORD });
    expect(login.status).toBe(200);
  });

  it("should re-assert revocation on a repeated suspension without a second history row", async () => {
    const doctor = await doctorWithStatus("active", "repeat.suspend@example.test");
    await internalPatch(doctor.id, change("suspended")).expect(200);
    await seedSession(doctor.id);
    expect(await liveTokenCount(doctor.id)).toBe(1);

    const response = await internalPatch(doctor.id, change("suspended"));

    expect(response.status).toBe(200);
    expect(await liveTokenCount(doctor.id)).toBe(0);
    expect(await historyRows(doctor.id)).toHaveLength(1);
  });

  it.each([
    ["pending", "suspended"],
    ["rejected", "active"],
    ["rejected", "suspended"],
    ["active", "rejected"],
    ["active", "pending"],
    ["suspended", "pending"],
    ["suspended", "rejected"],
  ] as const)("should answer 409 InvalidStatusTransition and change nothing for %s to %s", async (from, to) => {
    const doctor = await doctorWithStatus(from, `refused.${from}.${to}@example.test`);
    await seedSession(doctor.id);
    const before = await userRow(doctor.id);

    const response = await internalPatch(doctor.id, change(to));

    expect(response.status).toBe(409);
    expectErrorEnvelope(response.body, "InvalidStatusTransition");
    expectContractDeclares("/internal/users/{id}/status", "patch", 409, "InvalidStatusTransition");
    const after = await userRow(doctor.id);
    expect(after.status).toBe(from);
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
    expect(await historyRows(doctor.id)).toHaveLength(0);
    expect(await liveTokenCount(doctor.id)).toBe(1);
  });
});

describe("PATCH /internal/users/:id/status: doctor targets only (BR-19, ADR 0025)", () => {
  it.each(["patient", "admin"] as const)(
    "should answer 403 Forbidden and change nothing for a %s target, whatever the status asked",
    async (role) => {
      const target = await seedUser({ email: `non.doctor.${role}@example.test`, role, status: "active" });
      await seedSession(target.id);
      for (const status of ["active", "pending", "rejected", "suspended"]) {
        const response = await internalPatch(target.id, change(status));
        expect(response.status).toBe(403);
        expectErrorEnvelope(response.body, "Forbidden");
      }
      expectContractDeclares("/internal/users/{id}/status", "patch", 403, "Forbidden");
      expect((await userRow(target.id)).status).toBe("active");
      expect(await historyRows(target.id)).toHaveLength(0);
      expect(await liveTokenCount(target.id)).toBe(1);
    },
  );
});

describe("PATCH /internal/users/:id/status: validation and targets", () => {
  it("should answer 404 NotFound for an unknown or soft-deleted target", async () => {
    const gone = await doctorWithStatus("suspended", "deleted.doctor@example.test");
    await softDelete(gone.id);

    for (const id of [987654, gone.id]) {
      const response = await internalPatch(id, change("active"));
      expect(response.status).toBe(404);
      expectErrorEnvelope(response.body, "NotFound");
    }
    expectContractDeclares("/internal/users/{id}/status", "patch", 404, "NotFound");
  });

  it("should record NULL as the actor and still succeed when actorUserId does not exist", async () => {
    const doctor = await doctorWithStatus("suspended", "unknown.actor@example.test");
    const logs = captureLogs();

    try {
      const response = await internalPatch(doctor.id, change("active", { actorUserId: 424242 }));
      expect(response.status).toBe(200);
    } finally {
      logs.restore();
    }

    const rows = await historyRows(doctor.id);
    expect(rows[0]).toMatchObject({ actor_user_id: null, actor_service: "care-service" });
    expect(logs.lines().map((line) => line.message)).toContain("status_change_actor_unknown");
  });

  it("should record a soft-deleted actor normally", async () => {
    const doctor = await doctorWithStatus("suspended", "deleted.actor@example.test");
    const actor = await seedUser({ email: "deleted.actor.admin@example.test", role: "admin" });
    await softDelete(actor.id);

    await internalPatch(doctor.id, change("active", { actorUserId: actor.id })).expect(200);

    expect((await historyRows(doctor.id))[0]?.actor_user_id).toBe(String(actor.id));
  });

  it.each([
    ["an unknown status", change("banned")],
    ["a missing reason", { status: "active", actorUserId: ACTOR_ID }],
    ["a blank reason", change("active", { reason: "   " })],
    ["a reason over 500 characters", change("active", { reason: "x".repeat(501) })],
    ["a missing actorUserId", { status: "active", reason: REASON }],
    ["a string actorUserId", change("active", { actorUserId: "7" })],
    ["a zero actorUserId", change("active", { actorUserId: 0 })],
    ["an unknown property", change("active", { role: "admin" })],
  ])("should answer 400 ValidationFailed for %s and write nothing", async (_label, body) => {
    const doctor = await doctorWithStatus("suspended", `invalid.${String(Math.random()).slice(2, 8)}@example.test`);

    const response = await internalPatch(doctor.id, body);

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, "ValidationFailed");
    expectContractDeclares("/internal/users/{id}/status", "patch", 400, "ValidationFailed");
    expect((await userRow(doctor.id)).status).toBe("suspended");
    expect(await historyRows(doctor.id)).toHaveLength(0);
  });

  it.each(["0", "-1", "abc", "1.5", "01"])("should answer 400 ValidationFailed for the path id %p", async (id) => {
    const response = await internalPatch(id, change("active"));

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, "ValidationFailed");
  });

  it("should never log the reason or any personal data", async () => {
    const doctor = await doctorWithStatus("suspended", "log.scan.doctor@example.test");
    const logs = captureLogs();

    try {
      await internalPatch(doctor.id, change("active"));
    } finally {
      logs.restore();
    }

    expect(logs.text()).not.toContain(REASON);
    expect(logs.text()).not.toContain("log.scan.doctor@example.test");
    expect(logs.text()).not.toContain("Amira Hassan");
    expect(logs.lines().some((line) => line.message === "user_status_changed")).toBe(true);
  });
});

describe("PATCH /internal/users/:id/status: RBAC", () => {
  it("should answer 401 ServiceTokenRequired without a token and for a user token of any role, an admin's included", async () => {
    const doctor = await doctorWithStatus("suspended", "rbac.doctor@example.test");

    const none = await internalPatch(doctor.id, change("active"), null);
    expect(none.status).toBe(401);
    expectErrorEnvelope(none.body, "ServiceTokenRequired");

    for (const role of ["patient", "doctor", "admin"] as const) {
      const user = await seedUser({ email: `rbac.user.${role}@example.test`, role, status: "active" });
      const response = await internalPatch(doctor.id, change("active"), await signAccessToken(user));
      expect(response.status).toBe(401);
      expectErrorEnvelope(response.body, "ServiceTokenRequired");
    }
    expectContractDeclares("/internal/users/{id}/status", "patch", 401, "ServiceTokenRequired");
    expect((await userRow(doctor.id)).status).toBe("suspended");
  });

  it("should answer 403 InsufficientScope for a service token holding another scope, and change nothing", async () => {
    const doctor = await doctorWithStatus("suspended", "scope.doctor@example.test");

    for (const scope of ["users:read", "doctors:read", "users:contact:read"]) {
      const token = await signCustomServiceToken({ scope, subject: "care-service" });
      const response = await internalPatch(doctor.id, change("active"), token);
      expect(response.status).toBe(403);
      expectErrorEnvelope(response.body, "InsufficientScope");
    }
    expectContractDeclares("/internal/users/{id}/status", "patch", 403, "InsufficientScope");
    expect((await userRow(doctor.id)).status).toBe("suspended");
  });

  it("should not be reachable on the public listener", async () => {
    const response = await request(apps.publicApp)
      .patch("/internal/users/1/status")
      .set("Authorization", `Bearer ${writeToken}`)
      .send(change("active"));

    expect(response.status).toBe(404);
  });

  it("should ignore identity headers: the token alone decides", async () => {
    const doctor = await doctorWithStatus("suspended", "headers.doctor@example.test");

    const response = await internalPatch(doctor.id, change("active"), null, {
      "X-User-Id": "1",
      "X-Role": "admin",
    });

    expect(response.status).toBe(401);
    expect((await userRow(doctor.id)).status).toBe("suspended");
  });
});

describe("PATCH /internal/users/:id/status: atomicity", () => {
  it("should roll the status change back when the history insert fails", async () => {
    const doctor = await doctorWithStatus("suspended", "atomic.doctor@example.test");
    await db.raw(
      "CREATE OR REPLACE FUNCTION test_fail_history() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END; $$ LANGUAGE plpgsql",
    );
    await db.raw(
      "CREATE TRIGGER test_fail_history BEFORE INSERT ON user_status_changes FOR EACH ROW EXECUTE FUNCTION test_fail_history()",
    );

    try {
      const response = await internalPatch(doctor.id, change("active"));
      expect(response.status).toBe(500);
      expectErrorEnvelope(response.body, "InternalError");
    } finally {
      await db.raw("DROP TRIGGER IF EXISTS test_fail_history ON user_status_changes");
      await db.raw("DROP FUNCTION IF EXISTS test_fail_history()");
    }

    expect((await userRow(doctor.id)).status).toBe("suspended");
  });

  it("should leave an unrelated account untouched", async () => {
    const doctor = await doctorWithStatus("suspended", "isolated.doctor@example.test");
    const bystander = await doctorWithStatus("suspended", "bystander.doctor@example.test");
    await setStatus(bystander.id, "suspended");

    await internalPatch(doctor.id, change("active")).expect(200);

    expect((await userRow(bystander.id)).status).toBe("suspended");
  });
});
