import type { Express } from "express";
import request from "supertest";
import { db } from "../../../src/lib/knex/knex";
import { logger } from "../../../src/lib/logger/logger";
import { buildTestApps } from "../../helpers/app";
import {
  cookieFor,
  refreshCookieHeader,
  refreshTokenFrom,
  seedUser,
  setStatus,
  softDelete,
  TEST_PASSWORD,
  uuid,
} from "../../helpers/auth";
import {
  expectContractDeclares,
  expectErrorEnvelope,
  expectRefreshCookie,
  expectStatusChangePayload,
  expectSuccessEnvelope,
} from "../../helpers/contract";
import { closeDb, truncateAll } from "../../helpers/db";
import { captureLogs } from "../../helpers/log-capture";
import { closeRedis, flushTestKeys } from "../../helpers/redis";
import {
  authed,
  historyRows,
  listSessions,
  liveTokenCount,
  patchStatus,
  SECRET_MARKERS,
  seedAdmin,
  seedSession,
  tokenRows,
  userRow,
  type Admin,
} from "../../helpers/users";

const REASON = "Synthetic reason: repeated policy violations";

let apps: { publicApp: Express; internalApp: Express };
let admin: Admin;

function login(email: string, headers: Record<string, string> = {}): Promise<request.Response> {
  const call = request(apps.publicApp).post("/api/auth/login");
  for (const [name, value] of Object.entries(headers)) {
    void call.set(name, value);
  }
  return call.send({ email, password: TEST_PASSWORD });
}

function refreshWith(token: string): Promise<request.Response> {
  return request(apps.publicApp).post("/api/auth/refresh").set("Cookie", cookieFor(token));
}

function suspend(id: number, token: string = admin.token): request.Test {
  return patchStatus(apps.publicApp, token, id, { status: "suspended", reason: REASON });
}

function reinstate(id: number, token: string = admin.token): request.Test {
  return patchStatus(apps.publicApp, token, id, { status: "active", reason: REASON });
}

/** The target must be exactly as it was: status, updated_at, history and live tokens. */
interface Snapshot {
  status: string;
  updatedAt: number;
  history: number;
  live: number;
}

async function snapshot(userId: number): Promise<Snapshot> {
  const row = await userRow(userId);
  return {
    status: row.status,
    updatedAt: row.updated_at.getTime(),
    history: (await historyRows()).length,
    live: await liveTokenCount(userId),
  };
}

async function installFailingTrigger(table: string, event: "INSERT" | "UPDATE", name: string): Promise<void> {
  await db.raw(
    `CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'synthetic ${name}'; END; $$ LANGUAGE plpgsql`,
  );
  await db.raw(`CREATE TRIGGER ${name} BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
}

async function dropTriggers(): Promise<void> {
  await db.raw("DROP TRIGGER IF EXISTS test_fail_history ON user_status_changes");
  await db.raw("DROP FUNCTION IF EXISTS test_fail_history()");
  await db.raw("DROP TRIGGER IF EXISTS test_fail_revoke ON refresh_tokens");
  await db.raw("DROP FUNCTION IF EXISTS test_fail_revoke()");
}

beforeAll(() => {
  apps = buildTestApps();
});

beforeEach(async () => {
  await dropTriggers();
  await truncateAll();
  await flushTestKeys();
  admin = await seedAdmin();
});

afterEach(async () => {
  await dropTriggers();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("PATCH /api/users/:id/status: suspending a patient (BR-7, BR-8)", () => {
  it("should return the contract's StatusChangeResponse with no-store and persist the new status and updated_at", async () => {
    const patient = await seedUser({ email: "amira.patient@example.test" });
    const before = await userRow(patient.id);

    const response = await suspend(patient.id);

    expect(response.status).toBe(200);
    expectContractDeclares("/api/users/{id}/status", "patch", 200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const payload = expectStatusChangePayload(expectSuccessEnvelope(response.body));
    expect(payload).toMatchObject({ id: patient.id, status: "suspended" });

    const after = await userRow(patient.id);
    expect(after.status).toBe("suspended");
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    expect(new Date(payload.updatedAt).getTime()).toBe(after.updated_at.getTime());
  });

  it("should write exactly one history row with actor_user_id from the token, a null actor_service, the reason and the request id", async () => {
    const patient = await seedUser({ email: "history.patient@example.test" });
    const requestId = uuid();

    const response = await patchStatus(
      apps.publicApp,
      admin.token,
      patient.id,
      { status: "suspended", reason: REASON },
      { "X-Request-Id": requestId },
    );

    expect(response.status).toBe(200);
    const rows = await historyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: String(patient.id),
      from_status: "active",
      to_status: "suspended",
      actor_user_id: String(admin.user.id),
      actor_service: null,
      reason: REASON,
      request_id: requestId,
    });
    expect(rows[0]?.created_at).toBeInstanceOf(Date);
  });

  it("should record the generated request id when the caller sends none", async () => {
    const patient = await seedUser({ email: "generated.patient@example.test" });

    const response = await suspend(patient.id);

    const [row] = await historyRows();
    expect(row?.request_id).toBe(response.headers["x-request-id"]);
  });

  it("should record the admin who acted when two different admins act", async () => {
    const second = await seedAdmin("admin.two@example.test");
    const a = await seedUser({ email: "a.patient@example.test" });
    const b = await seedUser({ email: "b.patient@example.test" });

    await suspend(a.id, admin.token);
    await suspend(b.id, second.token);

    const rows = await historyRows();
    expect(rows.map((row) => row.actor_user_id)).toEqual([String(admin.user.id), String(second.user.id)]);
  });

  it("should revoke every live family of the target with reason status_changed and leave other users' tokens alone", async () => {
    const patient = await seedUser({ email: "devices.patient@example.test" });
    const bystander = await seedUser({ email: "bystander.patient@example.test" });
    const first = await login(patient.email, { "User-Agent": "phone" });
    await login(patient.email, { "User-Agent": "laptop" });
    await seedSession(patient.id, { deviceInfo: "tablet" });
    await refreshWith(refreshTokenFrom(first) ?? "");
    await seedSession(bystander.id);
    expect(await liveTokenCount(patient.id)).toBe(3);

    const response = await suspend(patient.id);

    expect(response.status).toBe(200);
    expect(await liveTokenCount(patient.id)).toBe(0);
    const rows = await tokenRows(patient.id);
    expect(rows.filter((row) => row.revoked_reason === "status_changed")).toHaveLength(3);
    expect(rows.filter((row) => row.revoked_reason === "rotated")).toHaveLength(1);
    expect(await liveTokenCount(bystander.id)).toBe(1);
  });

  it("should make the next refresh fail with the cookie cleared and refuse login with 403 AccountSuspended", async () => {
    const patient = await seedUser({ email: "refresh.patient@example.test" });
    const token = refreshTokenFrom(await login(patient.email)) ?? "";

    expect((await suspend(patient.id)).status).toBe(200);

    // The suspension already revoked the token (reason status_changed), so the refresh is a plain
    // RefreshTokenInvalid: the 403 AccountSuspended path of /refresh is for a token that is still live.
    const refresh = await refreshWith(token);
    expect(refresh.status).toBe(401);
    expectErrorEnvelope(refresh.body, "RefreshTokenInvalid");
    expectRefreshCookie(refreshCookieHeader(refresh), "clear");

    const relogin = await login(patient.email);
    expect(relogin.status).toBe(403);
    expectErrorEnvelope(relogin.body, "AccountSuspended");
    expect(refreshCookieHeader(relogin)).toBeUndefined();
    expect(await liveTokenCount(patient.id)).toBe(0);
  });

  it("should leave the patient's sessions list empty after the suspension", async () => {
    const patient = await seedUser({ email: "empty.patient@example.test" });
    await seedSession(patient.id);
    await suspend(patient.id);

    const response = await listSessions(apps.publicApp, admin.token, patient.id);

    expect(response.status).toBe(200);
    expect((response.body as { data: unknown[] }).data).toEqual([]);
  });

  it("should accept the same suspend twice and keep one history row (idempotent by nature)", async () => {
    const patient = await seedUser({ email: "twice.patient@example.test" });

    const first = await suspend(patient.id);
    const second = await suspend(patient.id);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await historyRows()).toHaveLength(1);
  });

  it("should ignore an Idempotency-Key because the route is idempotent without one", async () => {
    const patient = await seedUser({ email: "idem.patient@example.test" });

    const response = await patchStatus(
      apps.publicApp,
      admin.token,
      patient.id,
      { status: "suspended", reason: REASON },
      { "Idempotency-Key": uuid() },
    );

    expect(response.status).toBe(200);
    expect((await userRow(patient.id)).status).toBe("suspended");
  });
});

describe("PATCH /api/users/:id/status: reinstating a patient (BR-9)", () => {
  it("should reinstate a suspended patient, write one history row, revoke nothing and allow login again", async () => {
    const patient = await seedUser({ email: "back.patient@example.test" });
    await suspend(patient.id);
    const before = await userRow(patient.id);
    const live = await seedSession(patient.id);

    const response = await reinstate(patient.id);

    expect(response.status).toBe(200);
    expect(expectStatusChangePayload(expectSuccessEnvelope(response.body))).toMatchObject({
      id: patient.id,
      status: "active",
    });
    const after = await userRow(patient.id);
    expect(after.status).toBe("active");
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());

    const rows = await historyRows(patient.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      from_status: "suspended",
      to_status: "active",
      actor_user_id: String(admin.user.id),
      actor_service: null,
    });
    // Reinstatement revokes nothing: a token that is live stays live.
    expect(await liveTokenCount(patient.id)).toBe(1);
    expect((await refreshWith(live.token)).status).toBe(200);

    const relogin = await login(patient.email);
    expect(relogin.status).toBe(200);
  });

  it("should not revive the sessions that the suspension revoked", async () => {
    const patient = await seedUser({ email: "dead.patient@example.test" });
    const session = await seedSession(patient.id);
    await suspend(patient.id);
    await reinstate(patient.id);

    const refresh = await refreshWith(session.token);

    expect(refresh.status).toBe(401);
    expectErrorEnvelope(refresh.body, "RefreshTokenInvalid");
  });

  it("should keep an ordered history when a patient is suspended, reinstated and suspended again", async () => {
    const patient = await seedUser({ email: "cycle.patient@example.test" });

    await suspend(patient.id);
    await reinstate(patient.id);
    await suspend(patient.id);

    const rows = await historyRows(patient.id);
    expect(rows.map((row) => `${row.from_status}->${row.to_status}`)).toEqual([
      "active->suspended",
      "suspended->active",
      "active->suspended",
    ]);
  });
});

describe("PATCH /api/users/:id/status: same status is a no-op (BR-6)", () => {
  it("should answer 200 and change nothing when a suspended patient is suspended again", async () => {
    const patient = await seedUser({ email: "noop.suspended@example.test" });
    await suspend(patient.id);
    const stray = await seedSession(patient.id);
    const before = await snapshot(patient.id);

    const response = await suspend(patient.id);

    expect(response.status).toBe(200);
    expect(expectStatusChangePayload(expectSuccessEnvelope(response.body))).toMatchObject({
      id: patient.id,
      status: "suspended",
    });
    expect(await snapshot(patient.id)).toEqual(before);
    const row = await userRow(patient.id);
    expect(new Date(expectStatusChangePayload(expectSuccessEnvelope(response.body)).updatedAt).getTime()).toBe(
      row.updated_at.getTime(),
    );
    // A no-op revokes nothing: the stray token is still live.
    expect((await tokenRows(patient.id)).find((token) => Number(token.id) === stray.id)?.revoked_at).toBeNull();
  });

  it("should answer 200 and change nothing when an active patient is set to active", async () => {
    const patient = await seedUser({ email: "noop.active@example.test" });
    await seedSession(patient.id);
    const before = await snapshot(patient.id);

    const response = await reinstate(patient.id);

    expect(response.status).toBe(200);
    expect(expectStatusChangePayload(expectSuccessEnvelope(response.body)).status).toBe("active");
    expect(await snapshot(patient.id)).toEqual(before);
    expect(before.history).toBe(0);
  });
});

describe("PATCH /api/users/:id/status: target rules (BR-4, ADR 0012)", () => {
  async function expectRefusedAndUntouched(targetId: number, body: object, message: RegExp): Promise<void> {
    const before = await snapshot(targetId);

    const response = await patchStatus(apps.publicApp, admin.token, targetId, body);

    expect(response.status).toBe(403);
    expectContractDeclares("/api/users/{id}/status", "patch", 403, "Forbidden");
    expectErrorEnvelope(response.body, "Forbidden");
    expect((response.body as { error: { message: string } }).error.message).toMatch(message);
    expect(await snapshot(targetId)).toEqual(before);
  }

  it("should answer 403 Forbidden and write nothing when the admin targets themselves", async () => {
    await seedSession(admin.user.id);

    await expectRefusedAndUntouched(admin.user.id, { status: "suspended", reason: REASON }, /your own/);
    await expectRefusedAndUntouched(admin.user.id, { status: "active", reason: REASON }, /your own/);
  });

  it("should answer 403 Forbidden and write nothing when the admin targets another admin, even to the status it already has", async () => {
    const other = await seedAdmin("admin.two@example.test");
    await seedSession(other.user.id);

    await expectRefusedAndUntouched(other.user.id, { status: "suspended", reason: REASON }, /another admin/);
    await expectRefusedAndUntouched(other.user.id, { status: "active", reason: REASON }, /another admin/);
  });

  it.each(["pending", "active", "rejected", "suspended"] as const)(
    "should answer 403 Forbidden and write nothing when the target is a %s doctor",
    async (status) => {
      const doctor = await seedUser({ email: `${status}.doctor@example.test`, role: "doctor", status });
      await seedSession(doctor.id);

      for (const requested of ["active", "suspended"]) {
        await expectRefusedAndUntouched(doctor.id, { status: requested, reason: REASON }, /care-service/);
      }
    },
  );

  it("should answer 403 for a doctor before 409 so a doctor is never told which transitions are valid", async () => {
    const doctor = await seedUser({ email: "order.doctor@example.test", role: "doctor", status: "pending" });

    const response = await reinstate(doctor.id);

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, "Forbidden");
  });

  it("should use a distinct message for self, another admin and a doctor under the single code Forbidden", async () => {
    const other = await seedAdmin("admin.two@example.test");
    const doctor = await seedUser({ email: "msg.doctor@example.test", role: "doctor" });

    const messages = [admin.user.id, other.user.id, doctor.id].map(async (id) => {
      const response = await suspend(id);
      expect((response.body as { error: { code: string } }).error.code).toBe("Forbidden");
      return (response.body as { error: { message: string } }).error.message;
    });

    expect(new Set(await Promise.all(messages)).size).toBe(3);
  });

  it("should write no refusal reason or user data into the 403 body", async () => {
    const doctor = await seedUser({ email: "leak.doctor@example.test", role: "doctor", fullName: "Dalia Leakcheck" });

    const response = await suspend(doctor.id);

    const text = JSON.stringify(response.body);
    expect(text).not.toContain("leak.doctor@example.test");
    expect(text).not.toContain("Dalia Leakcheck");
    expect(text).not.toContain(REASON);
  });
});

describe("PATCH /api/users/:id/status: transition table (BR-5)", () => {
  it.each(["pending", "rejected"] as const)(
    "should answer 409 InvalidStatusTransition and write nothing when a %s patient is activated or suspended",
    async (status) => {
      const patient = await seedUser({ email: `${status}.patient@example.test`, status });
      await seedSession(patient.id);
      const before = await snapshot(patient.id);

      for (const requested of ["active", "suspended"]) {
        const response = await patchStatus(apps.publicApp, admin.token, patient.id, {
          status: requested,
          reason: REASON,
        });

        expect(response.status).toBe(409);
        expectContractDeclares("/api/users/{id}/status", "patch", 409, "InvalidStatusTransition");
        expectErrorEnvelope(response.body, "InvalidStatusTransition");
      }
      expect(await snapshot(patient.id)).toEqual(before);
    },
  );

  it("should never echo the current or requested status or the reason in the 409 body", async () => {
    const patient = await seedUser({ email: "echo.patient@example.test", status: "pending" });

    const response = await suspend(patient.id);

    const text = JSON.stringify((response.body as { error: unknown }).error);
    expect(text).not.toContain("pending");
    expect(text).not.toContain("suspended");
    expect(text).not.toContain(REASON);
  });
});

describe("PATCH /api/users/:id/status: not found (BR-3)", () => {
  it("should answer 404 NotFound when the id does not exist", async () => {
    const response = await suspend(999_999);

    expect(response.status).toBe(404);
    expectContractDeclares("/api/users/{id}/status", "patch", 404, "NotFound");
    expectErrorEnvelope(response.body, "NotFound");
    expect(await historyRows()).toHaveLength(0);
  });

  it("should answer 404 NotFound and write nothing when the target was soft-deleted", async () => {
    const patient = await seedUser({ email: "gone.patient@example.test" });
    await softDelete(patient.id);

    const response = await suspend(patient.id);

    expect(response.status).toBe(404);
    expectErrorEnvelope(response.body, "NotFound");
    expect((await userRow(patient.id)).status).toBe("active");
    expect(await historyRows()).toHaveLength(0);
  });
});

describe("PATCH /api/users/:id/status: validation", () => {
  async function expectBad(id: number | string, body: unknown, field: string): Promise<void> {
    const response = await patchStatus(apps.publicApp, admin.token, id, body);

    expect(response.status).toBe(400);
    expectContractDeclares("/api/users/{id}/status", "patch", 400, "ValidationFailed");
    expectErrorEnvelope(response.body, "ValidationFailed");
    const details = (response.body as { error: { details: { field: string }[] } }).error.details;
    expect(details.map((detail) => detail.field)).toContain(field);
  }

  it.each(["pending", "rejected", "deleted", "ACTIVE", ""])(
    "should answer 400 on field status when the requested status is %p (contract enum is active and suspended)",
    async (status) => {
      const patient = await seedUser({ email: `enum${status || "empty"}@example.test` });

      await expectBad(patient.id, { status, reason: REASON }, "status");
      expect((await userRow(patient.id)).status).toBe("active");
    },
  );

  it.each([
    ["empty", ""],
    ["blank", "   \n\t"],
    ["too long", "r".repeat(501)],
    ["not a string", 5],
    ["null", null],
  ])("should answer 400 on field reason when the reason is %s", async (_label, reason) => {
    const patient = await seedUser({ email: "reason.patient@example.test" });

    await expectBad(patient.id, { status: "suspended", reason }, "reason");
    expect(await historyRows()).toHaveLength(0);
  });

  it("should accept a reason of exactly 500 characters", async () => {
    const patient = await seedUser({ email: "long.patient@example.test" });

    const response = await patchStatus(apps.publicApp, admin.token, patient.id, {
      status: "suspended",
      reason: "r".repeat(500),
    });

    expect(response.status).toBe(200);
  });

  it("should answer 400 on the missing field when status or reason is omitted", async () => {
    const patient = await seedUser({ email: "missing.patient@example.test" });

    await expectBad(patient.id, { reason: REASON }, "status");
    await expectBad(patient.id, { status: "suspended" }, "reason");
  });

  it("should answer 400 'is not allowed' when the body carries an unknown field such as role or actorUserId", async () => {
    const patient = await seedUser({ email: "extra.patient@example.test" });

    await expectBad(patient.id, { status: "suspended", reason: REASON, role: "admin" }, "role");
    await expectBad(patient.id, { status: "suspended", reason: REASON, actorUserId: 99 }, "actorUserId");
    expect(await historyRows()).toHaveLength(0);
  });

  it("should answer 400 on field body when the body is not a JSON object", async () => {
    const patient = await seedUser({ email: "array.patient@example.test" });

    await expectBad(patient.id, ["suspended"], "body");
    await expectBad(patient.id, "suspended", "body");
  });

  it("should answer 400 ValidationFailed, not 500, when the body is malformed JSON", async () => {
    const patient = await seedUser({ email: "malformed.patient@example.test" });

    const response = await authed(request(apps.publicApp).patch(`/api/users/${String(patient.id)}/status`), admin.token)
      .set("Content-Type", "application/json")
      .send("{not json");

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, "ValidationFailed");
  });

  it("should answer 400 on field id when the path id is malformed", async () => {
    for (const id of ["abc", "0", "-1", "1.5"]) {
      await expectBad(id, { status: "suspended", reason: REASON }, "id");
    }
  });

  it("should validate before touching the database when the target does not exist", async () => {
    await expectBad(999_999, { status: "pending", reason: REASON }, "status");
  });
});

describe("PATCH /api/users/:id/status: one transaction (BR-7)", () => {
  it("should roll back the status, the history row and every revocation when the history insert fails", async () => {
    const patient = await seedUser({ email: "rollback.history@example.test" });
    await seedSession(patient.id);
    await seedSession(patient.id);
    const before = await snapshot(patient.id);
    await installFailingTrigger("user_status_changes", "INSERT", "test_fail_history");

    const response = await suspend(patient.id);

    expect(response.status).toBe(500);
    expectErrorEnvelope(response.body, "InternalError");
    expect(JSON.stringify(response.body)).not.toContain("synthetic");
    expect(await snapshot(patient.id)).toEqual(before);
    expect(before.live).toBe(2);
  });

  it("should roll back the status and leave no orphan history row when the revocation fails", async () => {
    const patient = await seedUser({ email: "rollback.revoke@example.test" });
    await seedSession(patient.id);
    const before = await snapshot(patient.id);
    await installFailingTrigger("refresh_tokens", "UPDATE", "test_fail_revoke");

    const response = await suspend(patient.id);

    expect(response.status).toBe(500);
    expectErrorEnvelope(response.body, "InternalError");
    expect(JSON.stringify(response.body)).not.toContain("synthetic");
    expect(await snapshot(patient.id)).toEqual(before);
    expect(await historyRows()).toHaveLength(0);
  });

  it("should succeed again once the failure is gone, proving the failed attempt left no partial state", async () => {
    const patient = await seedUser({ email: "retry.patient@example.test" });
    await seedSession(patient.id);
    await installFailingTrigger("user_status_changes", "INSERT", "test_fail_history");
    expect((await suspend(patient.id)).status).toBe(500);
    await dropTriggers();

    const response = await suspend(patient.id);

    expect(response.status).toBe(200);
    expect(await historyRows()).toHaveLength(1);
    expect(await liveTokenCount(patient.id)).toBe(0);
  });

  it("should write exactly one history row and answer 200 twice when two identical suspensions run concurrently", async () => {
    const patient = await seedUser({ email: "concurrent.patient@example.test" });
    await seedSession(patient.id);

    const [a, b] = await Promise.all([suspend(patient.id), suspend(patient.id)]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await historyRows()).toHaveLength(1);
    expect(await liveTokenCount(patient.id)).toBe(0);
  });

  it("should leave the account in the status of the last committed change when a suspend and a reinstate run concurrently", async () => {
    const patient = await seedUser({ email: "race.patient@example.test" });
    await setStatus(patient.id, "suspended");

    const results = await Promise.all([reinstate(patient.id), suspend(patient.id)]);

    for (const result of results) {
      expect(result.status).toBe(200);
    }
    const rows = await historyRows(patient.id);
    const finalStatus = (await userRow(patient.id)).status;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[rows.length - 1]?.to_status).toBe(finalStatus);
    // Each history row chains from the previous one: no lost update under the row lock.
    let expectedFrom = "suspended";
    for (const row of rows) {
      expect(row.from_status).toBe(expectedFrom);
      expectedFrom = row.to_status;
    }
  });
});

describe("PATCH /api/users/:id/status: privacy", () => {
  it("should write the reason, email, name and tokens to no log line when a status is changed", async () => {
    const patient = await seedUser({
      email: "private.patient@example.test",
      fullName: "Nadia Privatefixture",
      phone: "+201000000055",
    });
    await seedSession(patient.id);
    const secretReason = "Reason mentions Nadia Privatefixture and a clinical-sounding fixture string";
    const capture = captureLogs();
    try {
      await patchStatus(apps.publicApp, admin.token, patient.id, { status: "suspended", reason: secretReason });
      await patchStatus(apps.publicApp, admin.token, patient.id, { status: "active", reason: secretReason });
      await patchStatus(apps.publicApp, admin.token, admin.user.id, { status: "suspended", reason: secretReason });

      const text = capture.text();
      expect(text).toContain("user_status_changed");
      expect(text).not.toContain(secretReason);
      expect(text).not.toContain("clinical-sounding");
      expect(text).not.toContain("private.patient@example.test");
      expect(text).not.toContain("Nadia Privatefixture");
      expect(text).not.toContain("+201000000055");
      expect(text).not.toContain(admin.token);
    } finally {
      capture.restore();
      logger.setLevel("warn");
    }
  });

  it("should log the audit event with ids, statuses and the revoked count only", async () => {
    const patient = await seedUser({ email: "audit.patient@example.test" });
    await seedSession(patient.id);
    await seedSession(patient.id);
    const capture = captureLogs();
    try {
      await suspend(patient.id);

      const line = capture.lines().find((entry) => entry.message === "user_status_changed");
      expect(line).toMatchObject({
        actorUserId: admin.user.id,
        userId: patient.id,
        from: "active",
        to: "suspended",
        revokedSessions: 2,
      });
      expect(Object.keys(line ?? {})).not.toContain("reason");
    } finally {
      capture.restore();
      logger.setLevel("warn");
    }
  });

  it("should log a refusal with its cause and ids only", async () => {
    const doctor = await seedUser({ email: "refused.doctor@example.test", role: "doctor" });
    const capture = captureLogs();
    try {
      await suspend(doctor.id);

      const line = capture.lines().find((entry) => entry.message === "status_change_refused");
      expect(line).toMatchObject({ actorUserId: admin.user.id, userId: doctor.id, cause: "doctor" });
      expect(capture.text()).not.toContain("refused.doctor@example.test");
    } finally {
      capture.restore();
      logger.setLevel("warn");
    }
  });

  it("should never carry a secret or password hash in any response body of the route", async () => {
    const patient = await seedUser({ email: "body.patient@example.test" });

    const responses = [await suspend(patient.id), await reinstate(patient.id), await suspend(999_999)];

    for (const response of responses) {
      const text = JSON.stringify(response.body);
      for (const marker of SECRET_MARKERS) {
        expect(text).not.toContain(marker);
      }
      expect(text).not.toContain("body.patient@example.test");
    }
  });
});
