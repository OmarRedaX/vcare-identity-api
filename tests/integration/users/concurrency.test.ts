import type { Express } from "express";
import request from "supertest";
import { db } from "../../../src/lib/knex/knex";
import { logger } from "../../../src/lib/logger/logger";
import { MemoryCaptureEmailAdapter } from "../../../src/lib/email/memory-capture-adapter";
import { sha256Hex } from "../../../src/pkg/utils/crypto";
import { buildTestApps } from "../../helpers/app";
import {
  codeFromEmail,
  cookieFor,
  mutableClock,
  refreshCookieHeader,
  refreshTokenFrom,
  runOutbox,
  seedUser,
  setCookies,
  TEST_PASSWORD,
} from "../../helpers/auth";
import { expectErrorEnvelope, expectRefreshCookie } from "../../helpers/contract";
import { closeDb, truncateAll } from "../../helpers/db";
import { captureLogs } from "../../helpers/log-capture";
import { closeRedis, flushTestKeys } from "../../helpers/redis";
import { signAccessToken } from "../../helpers/tokens";
import type { MutableClock } from "../../helpers/types";
import {
  holdRowLock,
  historyRows,
  liveTokenCount,
  patchStatus,
  revokeSessions,
  seedAdmin,
  seedSession,
  sleep,
  tokenRows,
  userRow,
  waitForBlocked,
  type Admin,
} from "../../helpers/users";

/**
 * Spec 10.4 (ADR 0019 / ADR 0020): forced interleavings. A test-held transaction holds a real row lock, so a
 * real request is proven (through pg_stat_activity) to be blocked at the lock boundary before the lock is
 * released. Invariant asserted everywhere: no live refresh token remains for the revoked scope, no request
 * answers 500, and PostgreSQL reports no deadlock.
 */

const REASON = "Synthetic concurrency check";
const TOKEN_LOCK = /from "refresh_tokens"[\s\S]*for update/i;
const USER_SHARE = /from "users"[\s\S]*for share/i;
const USER_UPDATE_LOCK = /(from "users"[\s\S]*for update)|(update "users")/i;
const TOKEN_REVOKE_UPDATE = /update "refresh_tokens"/i;

let apps: { publicApp: Express; internalApp: Express };
let clock: MutableClock;
let email: MemoryCaptureEmailAdapter;
let admin: Admin;

/** supertest builds lazily; this sends now and resolves with the response. */
function fire(call: request.Test): Promise<request.Response> {
  return call.then((response) => response);
}

function refreshWith(token: string): request.Test {
  return request(apps.publicApp).post("/api/auth/refresh").set("Cookie", cookieFor(token));
}

function logoutWith(token: string): request.Test {
  return request(apps.publicApp).post("/api/auth/logout").set("Cookie", cookieFor(token));
}

function suspend(id: number): request.Test {
  return patchStatus(apps.publicApp, admin.token, id, { status: "suspended", reason: REASON });
}

function expectSomeBlockedOn(queries: string[], pattern: RegExp): void {
  expect(queries.some((query) => pattern.test(query))).toBe(true);
}

async function deadlockCount(): Promise<number> {
  const row = await db.raw<{ rows: { deadlocks: string }[] }>(
    "SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()",
  );
  return Number(row.rows[0]?.deadlocks ?? 0);
}

/** Pins `token`'s row; a refresh of it then waits holding the user's FOR SHARE lock (mid-transaction). */
async function pinnedRefresh(session: { id: number; token: string }): Promise<{
  gate: Awaited<ReturnType<typeof holdRowLock>>;
  refresh: Promise<request.Response>;
}> {
  const gate = await holdRowLock("refresh_tokens", session.id, "update");
  const refresh = fire(refreshWith(session.token));
  const blocked = await waitForBlocked(1);
  expectSomeBlockedOn(blocked, TOKEN_LOCK);
  return { gate, refresh };
}

async function loginFor(address: string): Promise<string> {
  const response = await request(apps.publicApp).post("/api/auth/login").send({ email: address, password: TEST_PASSWORD });
  expect(response.status).toBe(200);
  return refreshTokenFrom(response) ?? "";
}

async function familyOf(userId: number, token: string): Promise<string> {
  const row = await db("refresh_tokens")
    .select("family_id")
    .where({ user_id: userId, token_hash: sha256Hex(token) })
    .first<{ family_id: string }>();
  return row?.family_id ?? "";
}

beforeAll(() => {
  clock = mutableClock();
  email = new MemoryCaptureEmailAdapter();
  apps = buildTestApps({ overrides: { clock: clock.clock, emailPort: email } });
});

beforeEach(async () => {
  await truncateAll();
  await flushTestKeys();
  email.clear();
  clock.set(new Date());
  admin = await seedAdmin();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("suspend versus refresh (ADR 0019)", () => {
  it("should leave no refreshable token when a refresh holds the user share lock and the real suspension must wait for it", async () => {
    const patient = await seedUser({ email: "suspend.after@example.test" });
    const session = await seedSession(patient.id);
    const { gate, refresh } = await pinnedRefresh(session);
    try {
      const suspension = fire(suspend(patient.id));
      const blocked = await waitForBlocked(2);
      expectSomeBlockedOn(blocked, USER_UPDATE_LOCK);
      await gate.commit();

      const [refreshed, suspended] = await Promise.all([refresh, suspension]);

      expect(refreshed.status).toBe(200);
      expect(suspended.status).toBe(200);
      const successor = refreshTokenFrom(refreshed) ?? "";
      expect(successor).not.toBe("");
      expect(await liveTokenCount(patient.id)).toBe(0);
      const rows = await tokenRows(patient.id);
      expect(rows.map((row) => row.revoked_reason)).toEqual(["rotated", "status_changed"]);
      const replay = await fire(refreshWith(successor));
      expect(replay.status).toBe(401);
      expectErrorEnvelope(replay.body, "RefreshTokenInvalid");
    } finally {
      await gate.rollback().catch(() => undefined);
    }
  });

  it("should refuse the refresh and leave no refreshable token when the real suspension holds the user lock first", async () => {
    const patient = await seedUser({ email: "suspend.first@example.test" });
    const pinned = await seedSession(patient.id);
    const other = await seedSession(patient.id);
    // Pinning one token holds the suspension mid-transaction: it owns the user row lock and has changed the status.
    const gate = await holdRowLock("refresh_tokens", pinned.id, "update");
    try {
      const suspension = fire(suspend(patient.id));
      expectSomeBlockedOn(await waitForBlocked(1), TOKEN_REVOKE_UPDATE);
      const refresh = fire(refreshWith(other.token));
      const blocked = await waitForBlocked(2);
      expectSomeBlockedOn(blocked, USER_SHARE);
      await gate.commit();

      const [suspended, refreshed] = await Promise.all([suspension, refresh]);

      expect(suspended.status).toBe(200);
      expect(refreshed.status).toBe(401);
      expectErrorEnvelope(refreshed.body, "RefreshTokenInvalid");
      expectRefreshCookie(refreshCookieHeader(refreshed), "clear");
      expect(await liveTokenCount(patient.id)).toBe(0);
      expect((await userRow(patient.id)).status).toBe("suspended");
      expect(await historyRows(patient.id)).toHaveLength(1);
    } finally {
      await gate.rollback().catch(() => undefined);
    }
  });

  it("should answer 403 AccountSuspended and revoke the family when the status changed while the refresh waited for the user lock", async () => {
    const patient = await seedUser({ email: "suspend.waiting@example.test" });
    const session = await seedSession(patient.id);
    // Stands in for a status writer that has committed the new status but not yet reached the token rows.
    const writer = await holdRowLock("users", patient.id, "update");
    try {
      const refresh = fire(refreshWith(session.token));
      expectSomeBlockedOn(await waitForBlocked(1), USER_SHARE);
      await writer("users").where("id", patient.id).update({ status: "suspended" });
      await writer.commit();

      const refreshed = await refresh;

      expect(refreshed.status).toBe(403);
      expectErrorEnvelope(refreshed.body, "AccountSuspended");
      expectRefreshCookie(refreshCookieHeader(refreshed), "clear");
      expect(await liveTokenCount(patient.id)).toBe(0);
      expect((await tokenRows(patient.id))[0]?.revoked_reason).toBe("status_changed");
    } finally {
      await writer.rollback().catch(() => undefined);
    }
  });

  it("should end with zero live tokens, status suspended and no 500 across repeated random suspend and refresh races", async () => {
    const deadlocksBefore = await deadlockCount();
    const outcomes = new Set<number>();

    for (let round = 0; round < 15; round += 1) {
      const patient = await seedUser({ email: `stress${String(round)}@example.test` });
      const session = await seedSession(patient.id);
      const jitter = (): Promise<void> => sleep(Math.floor(Math.random() * 12));

      const [suspended, refreshed] = await Promise.all([
        jitter().then(() => fire(suspend(patient.id))),
        jitter().then(() => fire(refreshWith(session.token))),
      ]);

      expect(suspended.status).toBe(200);
      expect([200, 401, 403]).toContain(refreshed.status);
      outcomes.add(refreshed.status);
      expect(await liveTokenCount(patient.id)).toBe(0);
      expect((await userRow(patient.id)).status).toBe("suspended");
      const successor = refreshTokenFrom(refreshed);
      if (successor !== undefined) {
        expect((await fire(refreshWith(successor))).status).toBe(401);
      }
    }

    await sleep(1200);
    expect(await deadlockCount()).toBe(deadlocksBefore);
    expect(outcomes.size).toBeGreaterThanOrEqual(1);
  });
});

describe("admin session revoke versus refresh (ADR 0019)", () => {
  it("should leave no refreshable successor when a refresh holds the user share lock and the real revoke must wait for it", async () => {
    const patient = await seedUser({ email: "revoke.after@example.test" });
    const session = await seedSession(patient.id);
    const { gate, refresh } = await pinnedRefresh(session);
    try {
      const revoke = fire(revokeSessions(apps.publicApp, admin.token, patient.id));
      expectSomeBlockedOn(await waitForBlocked(2), USER_UPDATE_LOCK);
      await gate.commit();

      const [refreshed, revoked] = await Promise.all([refresh, revoke]);

      expect(refreshed.status).toBe(200);
      expect(revoked.status).toBe(204);
      expect(await liveTokenCount(patient.id)).toBe(0);
      expect((await tokenRows(patient.id)).map((row) => row.revoked_reason)).toEqual(["rotated", "admin_revoked"]);
      expect((await fire(refreshWith(refreshTokenFrom(refreshed) ?? ""))).status).toBe(401);
    } finally {
      await gate.rollback().catch(() => undefined);
    }
  });

  it("should refuse the refresh when the real revoke holds the user lock first", async () => {
    const patient = await seedUser({ email: "revoke.first@example.test" });
    const pinned = await seedSession(patient.id);
    const other = await seedSession(patient.id);
    const gate = await holdRowLock("refresh_tokens", pinned.id, "update");
    try {
      const revoke = fire(revokeSessions(apps.publicApp, admin.token, patient.id));
      expectSomeBlockedOn(await waitForBlocked(1), TOKEN_REVOKE_UPDATE);
      const refresh = fire(refreshWith(other.token));
      expectSomeBlockedOn(await waitForBlocked(2), USER_SHARE);
      await gate.commit();

      const [revoked, refreshed] = await Promise.all([revoke, refresh]);

      expect(revoked.status).toBe(204);
      expect(refreshed.status).toBe(401);
      expectErrorEnvelope(refreshed.body, "RefreshTokenInvalid");
      expect(await liveTokenCount(patient.id)).toBe(0);
    } finally {
      await gate.rollback().catch(() => undefined);
    }
  });
});

describe("logout versus refresh of the same family (ADR 0020)", () => {
  it("should leave no live token in the family when logout waits for a refresh that holds the user share lock", async () => {
    const patient = await seedUser({ email: "logout.after@example.test" });
    const session = await seedSession(patient.id);
    const { gate, refresh } = await pinnedRefresh(session);
    try {
      const logout = fire(logoutWith(session.token));
      expectSomeBlockedOn(await waitForBlocked(2), USER_UPDATE_LOCK);
      await gate.commit();

      const [refreshed, loggedOut] = await Promise.all([refresh, logout]);

      expect(refreshed.status).toBe(200);
      expect(loggedOut.status).toBe(204);
      expect(await liveTokenCount(patient.id, session.familyId)).toBe(0);
      expect((await tokenRows(patient.id)).map((row) => row.revoked_reason)).toEqual(["rotated", "logout"]);
    } finally {
      await gate.rollback().catch(() => undefined);
    }
  });

  it("should answer the refresh 401 and create no successor when logout holds the user lock first", async () => {
    const patient = await seedUser({ email: "logout.first@example.test" });
    const session = await seedSession(patient.id);
    const gate = await holdRowLock("refresh_tokens", session.id, "update");
    try {
      const logout = fire(logoutWith(session.token));
      expectSomeBlockedOn(await waitForBlocked(1), TOKEN_REVOKE_UPDATE);
      const refresh = fire(refreshWith(session.token));
      expectSomeBlockedOn(await waitForBlocked(2), USER_SHARE);
      await gate.commit();

      const [loggedOut, refreshed] = await Promise.all([logout, refresh]);

      expect(loggedOut.status).toBe(204);
      expect(refreshed.status).toBe(401);
      expect(setCookies(refreshed).some((cookie) => /vcare_rt=[A-Za-z0-9_-]{43}/.test(cookie))).toBe(false);
      expect(await tokenRows(patient.id)).toHaveLength(1);
      expect(await liveTokenCount(patient.id)).toBe(0);
    } finally {
      await gate.rollback().catch(() => undefined);
    }
  });
});

describe("password reset and change versus refresh (ADR 0020 follow-up)", () => {
  it("should leave no live token when reset-password races a refresh that holds the user share lock", async () => {
    const patient = await seedUser({ email: "reset.race@example.test" });
    const session = await seedSession(patient.id);
    expect((await request(apps.publicApp).post("/api/auth/forgot-password").send({ email: patient.email })).status).toBe(204);
    await runOutbox(email);
    const code = codeFromEmail(email.messages().find((sent) => sent.to === patient.email)?.text ?? "");
    const { gate, refresh } = await pinnedRefresh(session);
    try {
      const reset = fire(
        request(apps.publicApp)
          .post("/api/auth/reset-password")
          .send({ email: patient.email, code, newPassword: "Synthetic-New-Passw0rd" }),
      );
      expectSomeBlockedOn(await waitForBlocked(2), USER_UPDATE_LOCK);
      await gate.commit();

      const [refreshed, resetResponse] = await Promise.all([refresh, reset]);

      expect(refreshed.status).toBe(200);
      expect(resetResponse.status).toBe(204);
      expect(await liveTokenCount(patient.id)).toBe(0);
      expect((await tokenRows(patient.id)).map((row) => row.revoked_reason)).toEqual(["rotated", "password_reset"]);
    } finally {
      await gate.rollback().catch(() => undefined);
    }
  });

  it("should revoke the successor of another family and keep the presented family when change-password races a refresh of that other family", async () => {
    const patient = await seedUser({ email: "change.race@example.test" });
    const presented = await loginFor(patient.email);
    const presentedFamily = await familyOf(patient.id, presented);
    const other = await seedSession(patient.id);
    const { gate, refresh } = await pinnedRefresh(other);
    try {
      const change = fire(
        request(apps.publicApp)
          .post("/api/auth/change-password")
          .set("Authorization", `Bearer ${await signAccessToken(patient)}`)
          .set("Cookie", cookieFor(presented))
          .send({ currentPassword: TEST_PASSWORD, newPassword: "Synthetic-New-Passw0rd" }),
      );
      expectSomeBlockedOn(await waitForBlocked(2), USER_UPDATE_LOCK);
      await gate.commit();

      const [refreshed, changed] = await Promise.all([refresh, change]);

      expect(refreshed.status).toBe(200);
      expect(changed.status).toBe(204);
      expect(await liveTokenCount(patient.id, other.familyId)).toBe(0);
      expect(await liveTokenCount(patient.id, presentedFamily)).toBe(1);
    } finally {
      await gate.rollback().catch(() => undefined);
    }
  });
});

describe("reuse-detection revocation versus refresh of the successor (ADR 0020)", () => {
  it("should leave no live token in the family when a replayed rotated token races the refresh of its successor", async () => {
    const patient = await seedUser({ email: "reuse.race@example.test" });
    const first = await seedSession(patient.id);
    const rotated = await fire(refreshWith(first.token));
    expect(rotated.status).toBe(200);
    const second = (await tokenRows(patient.id))[1];
    const secondToken = refreshTokenFrom(rotated) ?? "";
    clock.advance(11_000);
    const { gate, refresh } = await pinnedRefresh({ id: Number(second?.id), token: secondToken });
    try {
      const replay = fire(refreshWith(first.token));
      expectSomeBlockedOn(await waitForBlocked(2), USER_UPDATE_LOCK);
      await gate.commit();

      const [refreshed, replayed] = await Promise.all([refresh, replay]);

      expect(refreshed.status).toBe(200);
      expect(replayed.status).toBe(401);
      expectErrorEnvelope(replayed.body, "RefreshTokenReused");
      expect(await liveTokenCount(patient.id, first.familyId)).toBe(0);
      const rows = await tokenRows(patient.id);
      expect(rows).toHaveLength(3);
      expect(rows[2]?.revoked_reason).toBe("reuse_detected");
      expect((await fire(refreshWith(refreshTokenFrom(refreshed) ?? ""))).status).toBe(401);
    } finally {
      await gate.rollback().catch(() => undefined);
    }
  });

  it("should leave no live token and still answer reused when the replay wins the user lock first", async () => {
    const patient = await seedUser({ email: "reuse.first@example.test" });
    const first = await seedSession(patient.id);
    const rotated = await fire(refreshWith(first.token));
    const second = (await tokenRows(patient.id))[1];
    const secondToken = refreshTokenFrom(rotated) ?? "";
    clock.advance(11_000);
    const gate = await holdRowLock("refresh_tokens", Number(second?.id), "update");
    try {
      const replay = fire(refreshWith(first.token));
      expectSomeBlockedOn(await waitForBlocked(1), TOKEN_REVOKE_UPDATE);
      const refresh = fire(refreshWith(secondToken));
      expectSomeBlockedOn(await waitForBlocked(2), USER_SHARE);
      await gate.commit();

      const [replayed, refreshed] = await Promise.all([replay, refresh]);

      expect(replayed.status).toBe(401);
      expectErrorEnvelope(replayed.body, "RefreshTokenReused");
      expect(refreshed.status).toBe(401);
      expect(await liveTokenCount(patient.id)).toBe(0);
      expect(await tokenRows(patient.id)).toHaveLength(2);
    } finally {
      await gate.rollback().catch(() => undefined);
    }
  });
});

describe("refresh against refresh (FOR SHARE)", () => {
  it("should let refreshes of different families of one user complete while another transaction holds the user share lock", async () => {
    const patient = await seedUser({ email: "share.patient@example.test" });
    const a = await seedSession(patient.id);
    const b = await seedSession(patient.id);
    const share = await holdRowLock("users", patient.id, "share");
    try {
      // Both complete with the share lock still held: share locks coexist, so neither waits for the other.
      const [first, second] = await Promise.all([fire(refreshWith(a.token)), fire(refreshWith(b.token))]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      // A writer, by contrast, must wait for the share holder.
      const suspension = fire(suspend(patient.id));
      expectSomeBlockedOn(await waitForBlocked(1), USER_UPDATE_LOCK);
      await share.commit();
      expect((await suspension).status).toBe(200);
      expect(await liveTokenCount(patient.id)).toBe(0);
    } finally {
      await share.rollback().catch(() => undefined);
    }
  });

  it("should rotate exactly once and answer the other with the grace response when two refreshes carry the same token", async () => {
    const patient = await seedUser({ email: "same.token@example.test" });
    const session = await seedSession(patient.id);
    const hold = await holdRowLock("users", patient.id, "update");
    try {
      const calls = [fire(refreshWith(session.token)), fire(refreshWith(session.token))];
      expectSomeBlockedOn(await waitForBlocked(2), USER_SHARE);
      await hold.commit();

      const results = await Promise.all(calls);

      expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
      const failed = results.find((result) => result.status === 401);
      expectErrorEnvelope(failed?.body, "RefreshTokenInvalid");
      expect(setCookies(failed as request.Response)).toEqual([]);
      const rows = await tokenRows(patient.id);
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.revoked_at === null)).toHaveLength(1);
      expect(rows.map((row) => row.revoked_reason)).toEqual(["rotated", null]);
    } finally {
      await hold.rollback().catch(() => undefined);
    }
  });

  it("should keep exactly one live token after many concurrent refreshes of the same token", async () => {
    const patient = await seedUser({ email: "burst.patient@example.test" });
    const session = await seedSession(patient.id);

    const results = await Promise.all(Array.from({ length: 6 }, () => fire(refreshWith(session.token))));

    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    for (const result of results) {
      expect([200, 401]).toContain(result.status);
    }
    expect(await liveTokenCount(patient.id)).toBe(1);
    expect((await tokenRows(patient.id)).some((row) => row.revoked_reason === "reuse_detected")).toBe(false);
  });
});

describe("everything at once", () => {
  it("should not deadlock, answer 500, or leave a live token when suspend, revoke, logout and refreshes hit one user together", async () => {
    const deadlocksBefore = await deadlockCount();
    const capture = captureLogs({ level: "warn" });
    try {
      for (let round = 0; round < 10; round += 1) {
        const patient = await seedUser({ email: `chaos${String(round)}@example.test` });
        const sessions = [await seedSession(patient.id), await seedSession(patient.id), await seedSession(patient.id)];
        const jitter = (): Promise<void> => sleep(Math.floor(Math.random() * 15));
        const calls: Promise<request.Response>[] = [
          jitter().then(() => fire(suspend(patient.id))),
          jitter().then(() => fire(revokeSessions(apps.publicApp, admin.token, patient.id))),
          jitter().then(() => fire(logoutWith(sessions[0]?.token ?? ""))),
          jitter().then(() => fire(refreshWith(sessions[0]?.token ?? ""))),
          jitter().then(() => fire(refreshWith(sessions[1]?.token ?? ""))),
          jitter().then(() => fire(refreshWith(sessions[2]?.token ?? ""))),
        ];

        const [suspended, revoked, loggedOut, ...refreshes] = await Promise.all(calls);

        expect(suspended?.status).toBe(200);
        expect(revoked?.status).toBe(204);
        expect(loggedOut?.status).toBe(204);
        for (const refreshed of refreshes) {
          expect([200, 401, 403]).toContain(refreshed.status);
        }
        expect(await liveTokenCount(patient.id)).toBe(0);
        expect((await userRow(patient.id)).status).toBe("suspended");
      }

      const text = capture.text();
      expect(text).not.toContain("40P01");
      expect(text).not.toContain("deadlock");
      expect(text).not.toContain("unhandled_error");
    } finally {
      capture.restore();
      logger.setLevel("warn");
    }
    await sleep(1200);
    expect(await deadlockCount()).toBe(deadlocksBefore);
  });

  it("should leave an active user able to refresh and log in when only revokes and logouts race (no lost sessions of other users)", async () => {
    const patient = await seedUser({ email: "survivor.patient@example.test" });
    const bystander = await seedUser({ email: "bystander.patient@example.test" });
    const mine = await seedSession(patient.id);
    const theirs = await seedSession(bystander.id);

    const results = await Promise.all([
      fire(revokeSessions(apps.publicApp, admin.token, patient.id)),
      fire(logoutWith(mine.token)),
      fire(refreshWith(theirs.token)),
    ]);

    expect(results[0].status).toBe(204);
    expect(results[1].status).toBe(204);
    expect(results[2].status).toBe(200);
    expect(await liveTokenCount(patient.id)).toBe(0);
    expect(await liveTokenCount(bystander.id)).toBe(1);
    expect((await userRow(patient.id)).status).toBe("active");
  });
});
