import type { Express } from "express";
import request from "supertest";
import { db } from "../../../src/lib/knex/knex";
import { buildTestApps } from "../../helpers/app";
import {
  cookieFor,
  refreshTokenFrom,
  seedUser,
  setCookies,
  setStatus,
  TEST_PASSWORD,
  uuid,
} from "../../helpers/auth";
import { expectErrorEnvelope } from "../../helpers/contract";
import { closeDb, truncateAll } from "../../helpers/db";
import { closeRedis, flushTestKeys } from "../../helpers/redis";
import {
  signAccessToken,
  signExpiredAccessToken,
  signServiceTypedToken,
} from "../../helpers/tokens";

const NEW_PASSWORD = "Synthetic-New-Passw0rd";

interface TokenRow {
  id: string;
  user_id: string;
  family_id: string;
  revoked_at: Date | null;
  revoked_reason: string | null;
}

let apps: { publicApp: Express; internalApp: Express };

function login(address: string, password: string = TEST_PASSWORD): Promise<request.Response> {
  return request(apps.publicApp).post("/api/auth/login").send({ email: address, password });
}

function changePassword(
  token: string,
  body: object,
  headers: Record<string, string> = {},
): request.Test {
  const call = request(apps.publicApp)
    .post("/api/auth/change-password")
    .set("Authorization", `Bearer ${token}`);
  for (const [name, value] of Object.entries(headers)) {
    void call.set(name, value);
  }
  return call.send(body);
}

function tokenRows(userId: number): Promise<TokenRow[]> {
  return db<TokenRow>("refresh_tokens").select("*").where("user_id", userId).orderBy("id", "asc");
}

beforeAll(() => {
  apps = buildTestApps();
});

beforeEach(async () => {
  await truncateAll();
  await flushTestKeys();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("POST /api/auth/change-password", () => {
  it("should change the password, keep the presented family and revoke the others", async () => {
    const user = await seedUser({ email: "change.patient@example.test" });
    const keptToken = refreshTokenFrom(await login(user.email)) ?? "";
    const otherToken = refreshTokenFrom(await login(user.email)) ?? "";
    const accessToken = await signAccessToken(user);

    const response = await changePassword(
      accessToken,
      { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD },
      { Cookie: cookieFor(keptToken) },
    );

    expect(response.status).toBe(204);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(setCookies(response)).toEqual([]);

    const rows = await tokenRows(user.id);
    const kept = rows.find((row) => row.revoked_at === null);
    expect(rows).toHaveLength(2);
    expect(kept).toBeDefined();
    expect(rows.find((row) => row.revoked_at !== null)?.revoked_reason).toBe("password_changed");

    expect((await request(apps.publicApp).post("/api/auth/refresh").set("Cookie", cookieFor(keptToken))).status).toBe(200);
    expect((await request(apps.publicApp).post("/api/auth/refresh").set("Cookie", cookieFor(otherToken))).status).toBe(401);
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
    expect((await login(user.email, TEST_PASSWORD)).status).toBe(401);
  });

  it("should revoke every family when no cookie is sent", async () => {
    const user = await seedUser({ email: "nocookie.change@example.test" });
    await login(user.email);
    await login(user.email);

    const response = await changePassword(await signAccessToken(user), {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(response.status).toBe(204);
    const rows = await tokenRows(user.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revoked_reason === "password_changed")).toBe(true);
  });

  it("should revoke every family of the caller and touch nobody else when another user's cookie is sent", async () => {
    const caller = await seedUser({ email: "caller.change@example.test" });
    const stranger = await seedUser({ email: "stranger.change@example.test" });
    await login(caller.email);
    const strangerToken = refreshTokenFrom(await login(stranger.email)) ?? "";

    const response = await changePassword(
      await signAccessToken(caller),
      { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD },
      { Cookie: cookieFor(strangerToken) },
    );

    expect(response.status).toBe(204);
    expect((await tokenRows(caller.id)).every((row) => row.revoked_at !== null)).toBe(true);
    expect((await tokenRows(stranger.id)).every((row) => row.revoked_at === null)).toBe(true);
    const strangerHash = await db("users").select("password_hash").where("id", stranger.id).first<Record<string, unknown> | undefined>();
    expect((await login(stranger.email, TEST_PASSWORD)).status).toBe(200);
    expect(strangerHash?.password_hash).toBeDefined();
  });

  it("should return 401 InvalidCredentials and change nothing when the current password is wrong", async () => {
    const user = await seedUser({ email: "wrongcurrent.change@example.test" });
    const before = await db("users").select("password_hash").where("id", user.id).first<Record<string, unknown> | undefined>();

    const response = await changePassword(await signAccessToken(user), {
      currentPassword: "Not-The-Passw0rd",
      newPassword: NEW_PASSWORD,
    });

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, "InvalidCredentials");
    const after = await db("users").select("password_hash").where("id", user.id).first<Record<string, unknown> | undefined>();
    expect(after?.password_hash).toBe(before?.password_hash);
  });

  it("should return 400 when the new password is too short or on the denylist", async () => {
    const user = await seedUser({ email: "weak.change@example.test" });
    const token = await signAccessToken(user);

    const short = await changePassword(token, {
      currentPassword: TEST_PASSWORD,
      newPassword: "Short1!",
    });
    const common = await changePassword(token, {
      currentPassword: TEST_PASSWORD,
      newPassword: "password123",
    });

    expect(short.status).toBe(400);
    expect(common.status).toBe(400);
    expectErrorEnvelope(common.body, "ValidationFailed");
    expect(
      (common.body as { error: { details: { field: string; issue: string }[] } }).error.details,
    ).toEqual([{ field: "newPassword", issue: "is too common" }]);
  });

  it("should return 403 AccountSuspended when the row is suspended but the access token is still valid", async () => {
    const user = await seedUser({ email: "suspended.change@example.test" });
    const token = await signAccessToken(user);
    await setStatus(user.id, "suspended");

    const response = await changePassword(token, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, "AccountSuspended");
    // The refused change must not have touched the hash: the new password is simply wrong (401), while the
    // original, correct password is refused only because the account is suspended (403).
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(401);
    const original = await login(user.email, TEST_PASSWORD);
    expect(original.status).toBe(403);
    expectErrorEnvelope(original.body, "AccountSuspended");
  });

  it("should serve pending and rejected accounts when they change their password", async () => {
    for (const status of ["pending", "rejected"] as const) {
      const user = await seedUser({ email: `${status}.change@example.test`, role: "doctor", status });

      const response = await changePassword(await signAccessToken(user), {
        currentPassword: TEST_PASSWORD,
        newPassword: NEW_PASSWORD,
      });

      expect(response.status).toBe(204);
    }
  });

  it("should return 401 when no token, an expired token, or a service-typed token is presented", async () => {
    const user = await seedUser({ email: "rbac.change@example.test" });
    const body = { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD };

    const anonymous = await request(apps.publicApp).post("/api/auth/change-password").send(body);
    const expired = await changePassword(await signExpiredAccessToken(user), body);
    const service = await changePassword(await signServiceTypedToken(), body);

    expect(anonymous.status).toBe(401);
    expectErrorEnvelope(anonymous.body, "Unauthorized");
    expect(expired.status).toBe(401);
    expectErrorEnvelope(expired.body, "TokenExpired");
    expect(service.status).toBe(401);
    expectErrorEnvelope(service.body, "Unauthorized");
  });

  it("should return 429 RateLimited on the sixth attempt in fifteen minutes and not limit another user", async () => {
    const user = await seedUser({ email: "limited.change@example.test" });
    const other = await seedUser({ email: "unlimited.change@example.test" });
    const token = await signAccessToken(user);

    for (let i = 0; i < 5; i += 1) {
      const attempt = await changePassword(token, {
        currentPassword: "Not-The-Passw0rd",
        newPassword: NEW_PASSWORD,
      });
      expect(attempt.status).toBe(401);
    }

    const denied = await changePassword(token, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(denied.status).toBe(429);
    expectErrorEnvelope(denied.body, "RateLimited");
    expect(Number(denied.headers["retry-after"])).toBeGreaterThanOrEqual(1);

    const otherUser = await changePassword(await signAccessToken(other), {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(otherUser.status).toBe(204);
  });

  it("should replay the stored 204 and reject a different body under the same Idempotency-Key", async () => {
    const user = await seedUser({ email: "idem.change@example.test" });
    const token = await signAccessToken(user);
    const key = uuid();
    const body = { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD };

    const first = await changePassword(token, body, { "Idempotency-Key": key });
    const replay = await changePassword(token, body, { "Idempotency-Key": key });
    const conflicting = await changePassword(
      token,
      { currentPassword: NEW_PASSWORD, newPassword: "Third-Synthetic-Passw0rd" },
      { "Idempotency-Key": key },
    );

    expect(first.status).toBe(204);
    expect(replay.status).toBe(204);
    expect(conflicting.status).toBe(422);
    expectErrorEnvelope(conflicting.body, "IdempotencyConflict");
  });

  it("should never carry a hash or a password in the response of any change attempt", async () => {
    const user = await seedUser({ email: "secrets.change@example.test" });
    const token = await signAccessToken(user);

    const failed = await changePassword(token, {
      currentPassword: "Not-The-Passw0rd",
      newPassword: NEW_PASSWORD,
    });
    const succeeded = await changePassword(token, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    for (const response of [failed, succeeded]) {
      const serialized = `${JSON.stringify(response.body)}${response.text}`;
      expect(serialized).not.toContain("$argon2");
      expect(serialized).not.toContain(NEW_PASSWORD);
      expect(serialized).not.toContain(TEST_PASSWORD);
    }
  });
});
