import type { Express } from "express";
import request from "supertest";
import { db } from "../../../src/lib/knex/knex";
import { logger } from "../../../src/lib/logger/logger";
import { buildTestApps } from "../../helpers/app";
import {
  cookieFor,
  expireRefreshToken,
  refreshTokenFrom,
  seedUser,
  setStatus,
  softDelete,
  TEST_PASSWORD,
} from "../../helpers/auth";
import {
  expectContractDeclares,
  expectErrorEnvelope,
  expectPaginationMeta,
  expectSessionPayload,
  expectSuccessEnvelope,
} from "../../helpers/contract";
import { closeDb, truncateAll } from "../../helpers/db";
import { captureLogs } from "../../helpers/log-capture";
import { closeRedis, flushTestKeys } from "../../helpers/redis";
import { signAccessToken } from "../../helpers/tokens";
import {
  listSessions,
  liveTokenCount,
  revokeSessions,
  SECRET_MARKERS,
  seedAdmin,
  seedSession,
  tokenRows,
  type Admin,
} from "../../helpers/users";
import { sha256Hex } from "../../../src/pkg/utils/crypto";

let apps: { publicApp: Express; internalApp: Express };
let admin: Admin;

interface SessionJson {
  familyId: string;
  deviceInfo: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

function login(email: string, userAgent?: string): Promise<request.Response> {
  const call = request(apps.publicApp).post("/api/auth/login");
  if (userAgent !== undefined) {
    void call.set("User-Agent", userAgent);
  }
  return call.send({ email, password: TEST_PASSWORD });
}

function refreshWith(token: string): Promise<request.Response> {
  return request(apps.publicApp).post("/api/auth/refresh").set("Cookie", cookieFor(token));
}

async function fetchSessions(userId: number, query: Record<string, string> = {}): Promise<{
  items: SessionJson[];
  meta: { nextCursor: string | null; hasMore: boolean; count: number };
}> {
  const response = await listSessions(apps.publicApp, admin.token, userId, query);
  expect(response.status).toBe(200);
  const items = expectSuccessEnvelope(response.body) as SessionJson[];
  for (const item of items) {
    expectSessionPayload(item);
  }
  return { items, meta: expectPaginationMeta((response.body as { meta: unknown }).meta) };
}

beforeAll(() => {
  apps = buildTestApps();
});

beforeEach(async () => {
  await db.raw("DROP TRIGGER IF EXISTS test_fail_revoke ON refresh_tokens");
  await db.raw("DROP FUNCTION IF EXISTS test_fail_revoke()");
  await truncateAll();
  await flushTestKeys();
  admin = await seedAdmin();
});

afterAll(async () => {
  await db.raw("DROP TRIGGER IF EXISTS test_fail_revoke ON refresh_tokens");
  await db.raw("DROP FUNCTION IF EXISTS test_fail_revoke()");
  await closeRedis();
  await closeDb();
});

describe("GET /api/users/:id/sessions", () => {
  it("should return one Session per live family with the contract's shape and no-store", async () => {
    const patient = await seedUser({ email: "amira.patient@example.test" });
    await login(patient.email, "phone-agent/1.0");
    await login(patient.email, "laptop-agent/2.0");

    const response = await listSessions(apps.publicApp, admin.token, patient.id);

    expect(response.status).toBe(200);
    expectContractDeclares("/api/users/{id}/sessions", "get", 200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const items = expectSuccessEnvelope(response.body) as SessionJson[];
    expect(items).toHaveLength(2);
    for (const item of items) {
      expectSessionPayload(item);
    }
    expect(items.map((item) => item.deviceInfo).sort()).toEqual(["laptop-agent/2.0", "phone-agent/1.0"]);
    expect(expectPaginationMeta((response.body as { meta: unknown }).meta)).toEqual({
      nextCursor: null,
      hasMore: false,
      count: 2,
    });
  });

  it("should report createdAt from the family's first token and lastUsedAt and expiresAt from its current token after rotations (BR-14)", async () => {
    const patient = await seedUser({ email: "rotate.patient@example.test" });
    const first = refreshTokenFrom(await login(patient.email, "rotating-agent")) ?? "";
    const second = refreshTokenFrom(await refreshWith(first)) ?? "";
    await refreshWith(second);
    const rows = await tokenRows(patient.id);
    expect(rows).toHaveLength(3);

    const { items } = await fetchSessions(patient.id);

    expect(items).toHaveLength(1);
    const [session] = items;
    expect(session?.familyId).toBe(rows[0]?.family_id);
    expect(new Date(session?.createdAt ?? "").getTime()).toBe(rows[0]?.created_at.getTime());
    expect(new Date(session?.lastUsedAt ?? "").getTime()).toBe(rows[2]?.created_at.getTime());
    expect(new Date(session?.expiresAt ?? "").getTime()).toBe(rows[2]?.expires_at.getTime());
    expect(session?.deviceInfo).toBe("rotating-agent");
    expect(new Date(session?.lastUsedAt ?? "").getTime()).toBeGreaterThanOrEqual(
      new Date(session?.createdAt ?? "").getTime(),
    );
  });

  it("should list a family once, never one row per rotated token", async () => {
    const patient = await seedUser({ email: "once.patient@example.test" });
    let token = refreshTokenFrom(await login(patient.email)) ?? "";
    for (let i = 0; i < 4; i += 1) {
      token = refreshTokenFrom(await refreshWith(token)) ?? "";
    }

    const { items } = await fetchSessions(patient.id);

    expect(items).toHaveLength(1);
  });

  it("should list only live families: not logged-out, revoked, reuse-detected or expired ones", async () => {
    const patient = await seedUser({ email: "live.patient@example.test" });
    const live = await seedSession(patient.id, { deviceInfo: "live" });
    const loggedOut = await seedSession(patient.id, { deviceInfo: "logged-out" });
    const reused = await seedSession(patient.id, { deviceInfo: "reused" });
    const expired = await seedSession(patient.id, { deviceInfo: "expired" });
    const adminRevoked = await seedSession(patient.id, { deviceInfo: "revoked" });

    await request(apps.publicApp).post("/api/auth/logout").set("Cookie", cookieFor(loggedOut.token));
    await db("refresh_tokens")
      .where("family_id", reused.familyId)
      .update({ revoked_at: db.raw("now()"), revoked_reason: "reuse_detected" });
    await expireRefreshToken(expired.id);
    await db("refresh_tokens")
      .where("family_id", adminRevoked.familyId)
      .update({ revoked_at: db.raw("now()"), revoked_reason: "admin_revoked" });

    const { items } = await fetchSessions(patient.id);

    expect(items.map((item) => item.familyId)).toEqual([live.familyId]);
  });

  it("should not list a family whose current token expired even though an older rotated row exists", async () => {
    const patient = await seedUser({ email: "stale.patient@example.test" });
    const first = refreshTokenFrom(await login(patient.email)) ?? "";
    await refreshWith(first);
    const rows = await tokenRows(patient.id);
    await expireRefreshToken(Number(rows[1]?.id));

    const { items } = await fetchSessions(patient.id);

    expect(items).toEqual([]);
  });

  it("should never expose a token value, hash, token id or user id anywhere in the body (BR-14)", async () => {
    const patient = await seedUser({ email: "noleak.patient@example.test" });
    const login1 = await login(patient.email, "agent");
    const token = refreshTokenFrom(login1) ?? "";
    const rotatedToken = refreshTokenFrom(await refreshWith(token)) ?? "";

    const response = await listSessions(apps.publicApp, admin.token, patient.id);

    const text = JSON.stringify(response.body);
    expect(text).not.toContain(token);
    expect(text).not.toContain(rotatedToken);
    expect(text).not.toContain(sha256Hex(token));
    expect(text).not.toContain(sha256Hex(rotatedToken));
    for (const marker of SECRET_MARKERS) {
      expect(text).not.toContain(marker);
    }
    const [session] = (response.body as { data: Record<string, unknown>[] }).data;
    expect(Object.keys(session ?? {}).sort()).toEqual(["createdAt", "deviceInfo", "expiresAt", "familyId", "lastUsedAt"]);
  });

  it("should return a null deviceInfo when no User-Agent was captured", async () => {
    const patient = await seedUser({ email: "nodevice.patient@example.test" });
    await seedSession(patient.id, { deviceInfo: null });

    const { items } = await fetchSessions(patient.id);

    expect(items[0]?.deviceInfo).toBeNull();
  });

  it("should list only the target's families and none of another user's", async () => {
    const patient = await seedUser({ email: "mine.patient@example.test" });
    const other = await seedUser({ email: "theirs.patient@example.test" });
    const mine = await seedSession(patient.id);
    await seedSession(other.id);

    const { items } = await fetchSessions(patient.id);

    expect(items.map((item) => item.familyId)).toEqual([mine.familyId]);
  });

  it("should return an empty page, not an error, for a user without sessions and for a suspended user", async () => {
    const none = await seedUser({ email: "none.patient@example.test" });
    const suspended = await seedUser({ email: "suspended.patient@example.test" });
    await seedSession(suspended.id);
    await setStatus(suspended.id, "suspended");
    await db("refresh_tokens").where("user_id", suspended.id).update({ revoked_at: db.raw("now()"), revoked_reason: "status_changed" });

    for (const id of [none.id, suspended.id]) {
      const { items, meta } = await fetchSessions(id);

      expect(items).toEqual([]);
      expect(meta).toEqual({ nextCursor: null, hasMore: false, count: 0 });
    }
  });

  it("should list the sessions of a doctor and of an admin as well", async () => {
    const doctor = await seedUser({ email: "any.doctor@example.test", role: "doctor" });
    await seedSession(doctor.id);
    await seedSession(admin.user.id);

    expect((await fetchSessions(doctor.id)).items).toHaveLength(1);
    expect((await fetchSessions(admin.user.id)).items).toHaveLength(1);
  });

  describe("pagination (BR-15)", () => {
    it("should page on (createdAt DESC, familyId ASC), serve every family once, and reach page 2 on the default sort", async () => {
      const patient = await seedUser({ email: "paging.patient@example.test" });
      const families = [
        await seedSession(patient.id, { createdAt: "2026-05-01T00:00:00.000100Z" }),
        await seedSession(patient.id, { createdAt: "2026-05-01T00:00:00.000300Z" }),
        await seedSession(patient.id, { createdAt: "2026-05-01T00:00:00.000200Z" }),
        // Three families share one instant: the family id (ascending) breaks the tie.
        await seedSession(patient.id, { createdAt: "2026-05-02T00:00:00.000000Z" }),
        await seedSession(patient.id, { createdAt: "2026-05-02T00:00:00.000000Z" }),
        await seedSession(patient.id, { createdAt: "2026-05-02T00:00:00.000000Z" }),
        await seedSession(patient.id, { createdAt: "2026-04-01T00:00:00.000000Z" }),
      ];
      const tied = families.slice(3, 6).map((family) => family.familyId).sort();
      const expected = [
        ...tied,
        families[1]?.familyId,
        families[2]?.familyId,
        families[0]?.familyId,
        families[6]?.familyId,
      ];

      const served: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const query: Record<string, string> = { limit: "2" };
        if (cursor !== undefined) {
          query.cursor = cursor;
        }
        const page = await fetchSessions(patient.id, query);
        served.push(...page.items.map((item) => item.familyId));
        cursor = page.meta.nextCursor ?? undefined;
        pages += 1;
        expect(pages).toBeLessThan(20);
      } while (cursor !== undefined);

      expect(pages).toBe(4);
      expect(served).toEqual(expected);
      expect(new Set(served).size).toBe(7);
    });

    it("should end exactly at the boundary of the page size", async () => {
      const patient = await seedUser({ email: "boundary.patient@example.test" });
      for (let i = 0; i < 3; i += 1) {
        await seedSession(patient.id, { createdAt: `2026-05-0${String(i + 1)}T00:00:00.000000Z` });
      }

      const exact = await fetchSessions(patient.id, { limit: "3" });
      expect(exact.meta).toEqual({ nextCursor: null, hasMore: false, count: 3 });

      const short = await fetchSessions(patient.id, { limit: "2" });
      expect(short.meta).toMatchObject({ hasMore: true, count: 2 });
      const last = await fetchSessions(patient.id, { limit: "2", cursor: short.meta.nextCursor ?? "" });
      expect(last.meta).toEqual({ nextCursor: null, hasMore: false, count: 1 });
    });

    it("should keep the ordering by first-token time, not by the time of the current token", async () => {
      const patient = await seedUser({ email: "order.patient@example.test" });
      const older = refreshTokenFrom(await login(patient.email, "older")) ?? "";
      await new Promise((resolve) => setTimeout(resolve, 15));
      await login(patient.email, "newer");
      // Rotating the older family makes its current token the newest row, but its createdAt stays the oldest.
      await refreshWith(older);

      const { items } = await fetchSessions(patient.id);

      expect(items.map((item) => item.deviceInfo)).toEqual(["newer", "older"]);
    });

    it("should serve the default page size of 20 and report more when 21 families are live", async () => {
      const patient = await seedUser({ email: "many.patient@example.test" });
      for (let i = 0; i < 21; i += 1) {
        await seedSession(patient.id, { createdAt: `2026-05-01T00:00:${String(i).padStart(2, "0")}.000000Z` });
      }

      const first = await fetchSessions(patient.id);
      expect(first.meta).toMatchObject({ hasMore: true, count: 20 });
      const second = await fetchSessions(patient.id, { cursor: first.meta.nextCursor ?? "" });
      expect(second.meta).toEqual({ nextCursor: null, hasMore: false, count: 1 });
    });
  });

  describe("errors", () => {
    it("should answer 404 NotFound when the target does not exist or was soft-deleted (BR-3)", async () => {
      const gone = await seedUser({ email: "gone.patient@example.test" });
      await seedSession(gone.id);
      await softDelete(gone.id);

      for (const id of [gone.id, 999_999]) {
        const response = await listSessions(apps.publicApp, admin.token, id);

        expect(response.status).toBe(404);
        expectContractDeclares("/api/users/{id}/sessions", "get", 404, "NotFound");
        expectErrorEnvelope(response.body, "NotFound");
      }
    });

    it.each([
      ["id", "abc", {}],
      ["id", "0", {}],
      ["limit", "1", { limit: "0" }],
      ["limit", "1", { limit: "101" }],
      ["cursor", "1", { cursor: "not-a-cursor!!" }],
      ["role", "1", { role: "patient" }],
      ["sort", "1", { sort: "asc" }],
    ])("should answer 400 ValidationFailed naming %s when the id is %s and the query is %j", async (field, id, query) => {
      const response = await listSessions(apps.publicApp, admin.token, id, query);

      expect(response.status).toBe(400);
      expectContractDeclares("/api/users/{id}/sessions", "get", 400, "ValidationFailed");
      expectErrorEnvelope(response.body, "ValidationFailed");
      const details = (response.body as { error: { details: { field: string }[] } }).error.details;
      expect(details.map((detail) => detail.field)).toContain(field);
    });

    it("should answer 400 on field cursor when a user-list cursor (numeric tiebreaker) is used on the sessions list", async () => {
      const patient = await seedUser({ email: "cursor.patient@example.test" });
      const wrongShape = Buffer.from(
        JSON.stringify({ v: "2026-05-01T00:00:00.000000Z", id: 3 }),
        "utf8",
      ).toString("base64url");

      const response = await listSessions(apps.publicApp, admin.token, patient.id, { cursor: wrongShape });

      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, "ValidationFailed");
    });
  });
});

describe("DELETE /api/users/:id/sessions", () => {
  it("should answer 204 with no body, revoke every live family with admin_revoked, and leave other users alone (BR-13)", async () => {
    const patient = await seedUser({ email: "revoke.patient@example.test" });
    const bystander = await seedUser({ email: "bystander.patient@example.test" });
    const tokenA = refreshTokenFrom(await login(patient.email, "a")) ?? "";
    await login(patient.email, "b");
    await refreshWith(tokenA);
    await seedSession(bystander.id);
    expect(await liveTokenCount(patient.id)).toBe(2);

    const response = await revokeSessions(apps.publicApp, admin.token, patient.id);

    expect(response.status).toBe(204);
    expectContractDeclares("/api/users/{id}/sessions", "delete", 204);
    expect(response.text).toBe("");
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(await liveTokenCount(patient.id)).toBe(0);
    const rows = await tokenRows(patient.id);
    expect(rows.filter((row) => row.revoked_reason === "admin_revoked")).toHaveLength(2);
    expect(rows.filter((row) => row.revoked_reason === "rotated")).toHaveLength(1);
    expect(await liveTokenCount(bystander.id)).toBe(1);
  });

  it("should make the target's next refresh fail with RefreshTokenInvalid and still allow a fresh login", async () => {
    const patient = await seedUser({ email: "after.patient@example.test" });
    const token = refreshTokenFrom(await login(patient.email)) ?? "";

    await revokeSessions(apps.publicApp, admin.token, patient.id);

    const refresh = await refreshWith(token);
    expect(refresh.status).toBe(401);
    expectErrorEnvelope(refresh.body, "RefreshTokenInvalid");
    expect((await login(patient.email)).status).toBe(200);
  });

  it("should leave the account active and write no status history row", async () => {
    const patient = await seedUser({ email: "status.patient@example.test" });
    await seedSession(patient.id);

    await revokeSessions(apps.publicApp, admin.token, patient.id);

    const row = await db("users").select("status").where("id", patient.id).first<{ status: string }>();
    expect(row?.status).toBe("active");
    expect(await db("user_status_changes").count<{ count: string }[]>("id as count").first()).toMatchObject({ count: "0" });
  });

  it("should leave an already issued access token valid until it expires (accepted residual, ADR 0002)", async () => {
    const patient = await seedUser({ email: "residual.patient@example.test" });
    await seedSession(patient.id);
    const accessToken = await signAccessToken(patient);

    await revokeSessions(apps.publicApp, admin.token, patient.id);

    const me = await request(apps.publicApp).get("/api/auth/me").set("Authorization", `Bearer ${accessToken}`);
    expect(me.status).toBe(200);
  });

  it("should answer 204 again when repeated and when the user has no sessions (idempotent)", async () => {
    const patient = await seedUser({ email: "idem.patient@example.test" });
    await seedSession(patient.id);
    const never = await seedUser({ email: "never.patient@example.test" });

    expect((await revokeSessions(apps.publicApp, admin.token, patient.id)).status).toBe(204);
    expect((await revokeSessions(apps.publicApp, admin.token, patient.id)).status).toBe(204);
    expect((await revokeSessions(apps.publicApp, admin.token, never.id)).status).toBe(204);
  });

  it("should allow any existing target: a suspended patient, a doctor, another admin, and the caller itself", async () => {
    const suspended = await seedUser({ email: "suspended.patient@example.test", status: "suspended" });
    const doctor = await seedUser({ email: "any.doctor@example.test", role: "doctor" });
    const other = await seedAdmin("admin.two@example.test");
    const own = await seedSession(admin.user.id);
    for (const id of [suspended.id, doctor.id, other.user.id]) {
      await seedSession(id);
    }

    for (const id of [suspended.id, doctor.id, other.user.id, admin.user.id]) {
      expect((await revokeSessions(apps.publicApp, admin.token, id)).status).toBe(204);
      expect(await liveTokenCount(id)).toBe(0);
    }
    expect((await refreshWith(own.token)).status).toBe(401);
  });

  it("should ignore a request body", async () => {
    const patient = await seedUser({ email: "body.patient@example.test" });
    await seedSession(patient.id);

    const response = await request(apps.publicApp)
      .delete(`/api/users/${String(patient.id)}/sessions`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ anything: true });

    expect(response.status).toBe(204);
    expect(await liveTokenCount(patient.id)).toBe(0);
  });

  it("should answer 404 NotFound when the target does not exist or was soft-deleted (BR-3)", async () => {
    const gone = await seedUser({ email: "gone.patient@example.test" });
    await softDelete(gone.id);

    for (const id of [gone.id, 999_999]) {
      const response = await revokeSessions(apps.publicApp, admin.token, id);

      expect(response.status).toBe(404);
      expectContractDeclares("/api/users/{id}/sessions", "delete", 404, "NotFound");
      expectErrorEnvelope(response.body, "NotFound");
    }
  });

  it("should answer 400 ValidationFailed on field id when the path id is malformed", async () => {
    for (const id of ["abc", "0", "-5"]) {
      const response = await revokeSessions(apps.publicApp, admin.token, id);

      expect(response.status).toBe(400);
      expectContractDeclares("/api/users/{id}/sessions", "delete", 400, "ValidationFailed");
      expectErrorEnvelope(response.body, "ValidationFailed");
    }
  });

  it("should roll back and leave every family live when the revocation fails midway", async () => {
    const patient = await seedUser({ email: "rollback.patient@example.test" });
    await seedSession(patient.id);
    await seedSession(patient.id);
    await db.raw(
      "CREATE OR REPLACE FUNCTION test_fail_revoke() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'synthetic revoke failure'; END; $$ LANGUAGE plpgsql",
    );
    await db.raw(
      "CREATE TRIGGER test_fail_revoke BEFORE UPDATE ON refresh_tokens FOR EACH ROW EXECUTE FUNCTION test_fail_revoke()",
    );

    const response = await revokeSessions(apps.publicApp, admin.token, patient.id);

    expect(response.status).toBe(500);
    expectErrorEnvelope(response.body, "InternalError");
    expect(JSON.stringify(response.body)).not.toContain("synthetic");
    expect(await liveTokenCount(patient.id)).toBe(2);
  });

  it("should log the audit event with ids and the revoked count and never a token, email or name", async () => {
    const patient = await seedUser({ email: "audit.patient@example.test", fullName: "Rania Auditfixture" });
    const session = await seedSession(patient.id);
    await seedSession(patient.id);
    const capture = captureLogs();
    try {
      await revokeSessions(apps.publicApp, admin.token, patient.id);

      const line = capture.lines().find((entry) => entry.message === "admin_sessions_revoked");
      expect(line).toMatchObject({ actorUserId: admin.user.id, userId: patient.id, revokedSessions: 2 });
      const text = capture.text();
      expect(text).not.toContain(session.token);
      expect(text).not.toContain("audit.patient@example.test");
      expect(text).not.toContain("Rania Auditfixture");
      expect(text).not.toContain(admin.token);
    } finally {
      capture.restore();
      logger.setLevel("warn");
    }
  });
});
