import type { Express } from "express";
import type Redis from "ioredis";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import request from "supertest";
import { JWT_ISSUER, USER_TOKEN_AUDIENCE } from "../../../src/lib/auth/constants";
import { db } from "../../../src/lib/knex/knex";
import { redis } from "../../../src/lib/redis/redis";
import { buildTestApps } from "../../helpers/app";
import {
  bcryptHash,
  expireRefreshToken,
  cookieFor,
  hashPassword,
  mutableClock,
  refreshCookieHeader,
  refreshTokenFrom,
  seedUser,
  setCookies,
  setStatus,
  TEST_PASSWORD,
  uuid,
} from "../../helpers/auth";
import {
  expectAccessTokenPayload,
  expectErrorEnvelope,
  expectRefreshCookie,
  expectSuccessEnvelope,
  expectUserPayload,
} from "../../helpers/contract";
import { closeDb, truncateAll } from "../../helpers/db";
import { closeRedis, createUnreachableRedis, flushTestKeys } from "../../helpers/redis";
import type { MutableClock } from "../../helpers/types";

interface TokenRow {
  id: string;
  user_id: string;
  family_id: string;
  revoked_at: Date | null;
  revoked_reason: string | null;
  replaced_by_id: string | null;
  device_info: string | null;
  expires_at: Date;
}

let apps: { publicApp: Express; internalApp: Express };
let clock: MutableClock;
let unreachableRedis: Redis | undefined;

function tokenRows(): Promise<TokenRow[]> {
  return db<TokenRow>("refresh_tokens").select("*").orderBy("id", "asc");
}

async function login(
  email: string,
  password: string = TEST_PASSWORD,
  headers: Record<string, string> = {},
): Promise<request.Response> {
  const agent = request(apps.publicApp).post("/api/auth/login");
  for (const [name, value] of Object.entries(headers)) {
    void agent.set(name, value);
  }
  return agent.send({ email, password });
}

/** Resolves once some backend waits on a row lock, i.e. login has verified the password and reached its lock. */
async function waitForBlockedLock(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const blocked = await db.raw<{ rows: unknown[] }>(
      "SELECT 1 FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid', 'tuple') LIMIT 1",
    );
    if (blocked.rows.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("login never blocked on the user row lock");
}

function refreshWith(token: string): Promise<request.Response> {
  return request(apps.publicApp).post("/api/auth/refresh").set("Cookie", cookieFor(token));
}

beforeAll(() => {
  clock = mutableClock();
  apps = buildTestApps({ overrides: { clock: clock.clock } });
});

beforeEach(async () => {
  await truncateAll();
  await flushTestKeys();
  clock.set(new Date());
});

afterAll(async () => {
  unreachableRedis?.disconnect();
  await closeRedis();
  await closeDb();
});

describe("POST /api/auth/login", () => {
  it("should return the contract's LoginResponse and cookie when the credentials are valid", async () => {
    const user = await seedUser({ email: "login.patient@example.test" });

    const response = await login(user.email, TEST_PASSWORD, { "User-Agent": "jest-agent" });

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const data = expectSuccessEnvelope(response.body) as Record<string, unknown>;
    const accessToken = expectAccessTokenPayload(data);
    expectUserPayload(data.user);
    expect(accessToken.split(".")).toHaveLength(3);

    const cookieValue = expectRefreshCookie(refreshCookieHeader(response), "set");
    const rows = await tokenRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: String(user.id), revoked_at: null });
    expect(JSON.stringify(response.body)).not.toContain(cookieValue);
  });

  it("should store only the hash of the refresh token and a 30 day expiry when a session starts", async () => {
    const user = await seedUser({ email: "hashonly.patient@example.test" });

    const response = await login(user.email);
    const token = refreshTokenFrom(response) ?? "";

    const stored = await db("refresh_tokens").select("token_hash", "expires_at").first<Record<string, unknown> | undefined>();
    expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.token_hash).not.toContain(token);
    const days = (new Date(String(stored?.expires_at)).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it("should return the same 401 InvalidCredentials for an unknown email and a wrong password", async () => {
    const user = await seedUser({ email: "wrongpw.patient@example.test" });

    const unknown = await login("nobody@example.test");
    const wrong = await login(user.email, "Another-Passw0rd");

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expectErrorEnvelope(unknown.body, "InvalidCredentials");
    expectErrorEnvelope(wrong.body, "InvalidCredentials");
    expect({ ...(unknown.body as { error: object }).error, requestId: null }).toEqual({ ...(wrong.body as { error: object }).error, requestId: null });
    expect(refreshCookieHeader(unknown)).toBeUndefined();
    expect(await tokenRows()).toHaveLength(0);
  });

  it("should return 403 AccountSuspended when the password is right and the account is suspended", async () => {
    const user = await seedUser({ email: "suspended.patient@example.test", status: "suspended" });

    const response = await login(user.email);

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, "AccountSuspended");
    expect(await tokenRows()).toHaveLength(0);
  });

  it("should return 401 InvalidCredentials, never 403, when a suspended account sends a wrong password", async () => {
    const user = await seedUser({ email: "suspended2.patient@example.test", status: "suspended" });

    const response = await login(user.email, "Another-Passw0rd");

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, "InvalidCredentials");
  });

  it("should log in a pending doctor and a rejected doctor when their credentials are valid", async () => {
    const pending = await seedUser({ email: "pending.doctor@example.test", role: "doctor" });
    const rejected = await seedUser({
      email: "rejected.doctor@example.test",
      role: "doctor",
      status: "rejected",
    });

    const pendingLogin = await login(pending.email);
    const rejectedLogin = await login(rejected.email);

    expect(pendingLogin.status).toBe(200);
    expect(rejectedLogin.status).toBe(200);
    expect((expectSuccessEnvelope(pendingLogin.body) as { user: { status: string } }).user.status).toBe(
      "pending",
    );
    expect((expectSuccessEnvelope(rejectedLogin.body) as { user: { status: string } }).user.status).toBe(
      "rejected",
    );
  });

  it("should issue a token whose claims match the contract and verify against the published JWKS", async () => {
    const user = await seedUser({ email: "claims.doctor@example.test", role: "doctor", status: "rejected" });

    const response = await login(user.email);
    const accessToken = (expectSuccessEnvelope(response.body) as { accessToken: string }).accessToken;
    const jwks = await request(apps.publicApp).get("/.well-known/jwks.json");
    expect(jwks.headers["cache-control"]).toBe("public, max-age=300");
    expect(jwks.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const keySet = createLocalJWKSet(jwks.body as Parameters<typeof createLocalJWKSet>[0]);

    const verified = await jwtVerify(accessToken, keySet, {
      issuer: JWT_ISSUER,
      audience: "vcare-identity",
    });

    expect(decodeProtectedHeader(accessToken)).toMatchObject({ alg: "EdDSA" });
    expect(verified.payload).toMatchObject({
      sub: String(user.id),
      typ: "user",
      role: "doctor",
      status: "rejected",
      ev: true,
    });
    expect(verified.payload.aud).toEqual([...USER_TOKEN_AUDIENCE]);
    expect(Number(verified.payload.exp) - Number(verified.payload.iat)).toBe(900);
  });

  it("should rehash a legacy bcrypt hash to argon2id when the login succeeds", async () => {
    const user = await seedUser({
      email: "legacy.patient@example.test",
      passwordHash: await bcryptHash(),
    });

    const response = await login(user.email);

    expect(response.status).toBe(200);
    const stored = await db("users").select("password_hash").where("id", user.id).first<Record<string, unknown> | undefined>();
    expect(String(stored?.password_hash)).toMatch(/^\$argon2id\$/);

    const again = await login(user.email);
    expect(again.status).toBe(200);
  });

  it("should ignore an Idempotency-Key and create a second family when the same login is replayed", async () => {
    const user = await seedUser({ email: "idem.login@example.test" });
    const key = uuid();

    const first = await login(user.email, TEST_PASSWORD, { "Idempotency-Key": key });
    const second = await login(user.email, TEST_PASSWORD, { "Idempotency-Key": key });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(refreshTokenFrom(first)).not.toBe(refreshTokenFrom(second));

    const rows = await tokenRows();
    expect(new Set(rows.map((row) => row.family_id)).size).toBe(2);

    const stored = await redis.keys("idem:*");
    expect(stored.filter((storedKey) => storedKey.includes("/api/auth/login"))).toEqual([]);
  });

  it("should capture a sanitised User-Agent as device info when one is sent", async () => {
    const user = await seedUser({ email: "device.patient@example.test" });

    await login(user.email, TEST_PASSWORD, { "User-Agent": "vcare-tests/1.0" });

    const [row] = await tokenRows();
    expect(row?.device_info).toBe("vcare-tests/1.0");
  });

  it("should return 429 RateLimited when the sixth login for the same email and IP arrives within a minute", async () => {
    const user = await seedUser({ email: "bruteforce.patient@example.test" });

    for (let i = 0; i < 5; i += 1) {
      const attempt = await login(user.email, "Wrong-Passw0rd");
      expect(attempt.status).toBe(401);
    }

    const denied = await login(user.email, "Wrong-Passw0rd");

    expect(denied.status).toBe(429);
    expectErrorEnvelope(denied.body, "RateLimited");
    expect(Number(denied.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("should refuse the login and leave no session when a password reset commits after the password was verified", async () => {
    const user = await seedUser({ email: "race.patient@example.test" });
    const newHash = await hashPassword("Synthetic-New-Passw0rd");

    // Plays the part of a reset: holds the row lock, so login verifies the old hash and then waits for it.
    const reset = await db.transaction();
    await reset("users").where("id", user.id).forUpdate().first();
    const pending = login(user.email).then((response) => response);
    await waitForBlockedLock();
    await reset("users").where("id", user.id).update({ password_hash: newHash });
    await reset.commit();

    const response = await pending;

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, "InvalidCredentials");
    expect(refreshCookieHeader(response)).toBeUndefined();
    expect(await tokenRows()).toHaveLength(0);
  });

  it("should refuse the login when the account is suspended after the password was verified", async () => {
    const user = await seedUser({ email: "race.suspended@example.test" });

    const suspend = await db.transaction();
    await suspend("users").where("id", user.id).forUpdate().first();
    const pending = login(user.email).then((response) => response);
    await waitForBlockedLock();
    await suspend("users").where("id", user.id).update({ status: "suspended" });
    await suspend.commit();

    const response = await pending;

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, "AccountSuspended");
    expect(await tokenRows()).toHaveLength(0);
  });
});

describe("POST /api/auth/refresh", () => {
  it("should rotate the cookie and mark the old row rotated when a live token is presented", async () => {
    const user = await seedUser({ email: "rotate.patient@example.test" });
    const first = await login(user.email, TEST_PASSWORD, { "User-Agent": "vcare-tests/1.0" });
    const token = refreshTokenFrom(first) ?? "";

    const rotated = await refreshWith(token);

    expect(rotated.status).toBe(200);
    expect(rotated.headers["cache-control"]).toBe("no-store");
    expectAccessTokenPayload(expectSuccessEnvelope(rotated.body));
    const nextToken = expectRefreshCookie(refreshCookieHeader(rotated), "set");
    expect(nextToken).not.toBe(token);

    const rows = await tokenRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ revoked_reason: "rotated", replaced_by_id: rows[1]?.id });
    expect(rows[0]?.revoked_at).not.toBeNull();
    expect(rows[1]).toMatchObject({
      family_id: rows[0]?.family_id,
      revoked_at: null,
      device_info: "vcare-tests/1.0",
    });
  });

  it("should keep refreshing for a pending and a rejected account when the token is live", async () => {
    for (const status of ["pending", "rejected"] as const) {
      const user = await seedUser({ email: `refresh.${status}@example.test`, role: "doctor", status });
      const token = refreshTokenFrom(await login(user.email)) ?? "";

      const rotated = await refreshWith(token);

      expect(rotated.status).toBe(200);
    }
  });

  it("should answer 401 RefreshTokenInvalid without a Set-Cookie and keep the family when a rotated token is replayed inside the grace window", async () => {
    const user = await seedUser({ email: "grace.patient@example.test" });
    const token = refreshTokenFrom(await login(user.email)) ?? "";
    await refreshWith(token);

    const replay = await refreshWith(token);

    expect(replay.status).toBe(401);
    expectErrorEnvelope(replay.body, "RefreshTokenInvalid");
    expect(setCookies(replay)).toEqual([]);

    const rows = await tokenRows();
    expect(rows[1]?.revoked_at).toBeNull();
    expect(rows.map((row) => row.revoked_reason)).toEqual(["rotated", null]);
  });

  it("should revoke the whole family and answer 401 RefreshTokenReused when the replay comes after the grace window", async () => {
    const user = await seedUser({ email: "reuse.patient@example.test" });
    const token = refreshTokenFrom(await login(user.email)) ?? "";
    await refreshWith(token);

    clock.advance(11_000);
    const replay = await refreshWith(token);

    expect(replay.status).toBe(401);
    expectErrorEnvelope(replay.body, "RefreshTokenReused");
    expectRefreshCookie(refreshCookieHeader(replay), "clear");

    const rows = await tokenRows();
    expect(rows[1]).toMatchObject({ revoked_reason: "reuse_detected" });
    expect(rows.every((row) => row.revoked_at !== null)).toBe(true);
  });

  it("should revoke the family when the grace replay happens after the successor was itself rotated", async () => {
    const user = await seedUser({ email: "chain.patient@example.test" });
    const first = refreshTokenFrom(await login(user.email)) ?? "";
    const second = refreshTokenFrom(await refreshWith(first)) ?? "";
    await refreshWith(second);

    const replay = await refreshWith(first);

    expect(replay.status).toBe(401);
    expectErrorEnvelope(replay.body, "RefreshTokenReused");
    const rows = await tokenRows();
    expect(rows.every((row) => row.revoked_at !== null)).toBe(true);
  });

  it("should let exactly one of two concurrent refreshes rotate and answer the other with the grace response", async () => {
    const user = await seedUser({ email: "concurrent.patient@example.test" });
    const token = refreshTokenFrom(await login(user.email)) ?? "";

    const [a, b] = await Promise.all([refreshWith(token), refreshWith(token)]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);
    const failed = a.status === 401 ? a : b;
    expectErrorEnvelope(failed.body, "RefreshTokenInvalid");

    const rows = await tokenRows();
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.revoked_at === null)).toHaveLength(1);
    expect(rows.some((row) => row.revoked_reason === "reuse_detected")).toBe(false);
  });

  it("should answer 401 RefreshTokenInvalid with a clearing cookie for a missing, malformed, unknown, expired or logged-out token", async () => {
    const user = await seedUser({ email: "invalid.patient@example.test" });
    const expiredToken = refreshTokenFrom(await login(user.email)) ?? "";
    const [expiredRow] = await tokenRows();
    await expireRefreshToken(Number(expiredRow?.id));

    const loggedOutToken = refreshTokenFrom(await login(user.email)) ?? "";
    await request(apps.publicApp).post("/api/auth/logout").set("Cookie", cookieFor(loggedOutToken));

    const responses = [
      await request(apps.publicApp).post("/api/auth/refresh"),
      await refreshWith("malformed-token"),
      await refreshWith("Zm9vYmFyYmF6cXV1eGNvcmdlZ3JhdWx0Z2FycGx5Zm9v"),
      await refreshWith(expiredToken),
      await refreshWith(loggedOutToken),
    ];

    for (const response of responses) {
      expect(response.status).toBe(401);
      expectErrorEnvelope(response.body, "RefreshTokenInvalid");
      expectRefreshCookie(refreshCookieHeader(response), "clear");
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("should revoke the family and answer 403 AccountSuspended when the account was suspended meanwhile", async () => {
    const user = await seedUser({ email: "suspend.refresh@example.test" });
    const token = refreshTokenFrom(await login(user.email)) ?? "";
    await setStatus(user.id, "suspended");

    const response = await refreshWith(token);

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, "AccountSuspended");
    expectRefreshCookie(refreshCookieHeader(response), "clear");
    const rows = await tokenRows();
    expect(rows[0]).toMatchObject({ revoked_reason: "status_changed" });

    const retried = await refreshWith(token);
    expect(retried.status).toBe(401);
    expectErrorEnvelope(retried.body, "RefreshTokenInvalid");
  });

  it("should answer 401 RefreshTokenInvalid when the account was soft-deleted after the token was issued", async () => {
    const user = await seedUser({ email: "deleted.patient@example.test" });
    const token = refreshTokenFrom(await login(user.email)) ?? "";
    await db("users").where("id", user.id).update({ deleted_at: db.raw("now()") });

    const response = await refreshWith(token);

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, "RefreshTokenInvalid");
  });

  it("should answer 429 without touching the cookie when the family limiter trips", async () => {
    const user = await seedUser({ email: "refreshlimit.patient@example.test" });
    let token = refreshTokenFrom(await login(user.email)) ?? "";

    for (let i = 0; i < 29; i += 1) {
      const rotated = await refreshWith(token);
      expect(rotated.status).toBe(200);
      token = refreshTokenFrom(rotated) ?? "";
    }
    const thirtieth = await refreshWith(token);
    expect(thirtieth.status).toBe(200);
    token = refreshTokenFrom(thirtieth) ?? "";

    const denied = await refreshWith(token);

    expect(denied.status).toBe(429);
    expectErrorEnvelope(denied.body, "RateLimited");
    expect(Number(denied.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(setCookies(denied)).toEqual([]);
  });

  it("should still rotate when Redis is unreachable, because the family limiter fails open", async () => {
    unreachableRedis ??= createUnreachableRedis();
    const failOpenApps = buildTestApps({
      overrides: { clock: clock.clock, redis: unreachableRedis },
    });
    const user = await seedUser({ email: "failopen.patient@example.test" });
    const token = refreshTokenFrom(await login(user.email)) ?? "";

    const response = await request(failOpenApps.publicApp)
      .post("/api/auth/refresh")
      .set("Cookie", cookieFor(token));

    expect(response.status).toBe(200);
    expectAccessTokenPayload(expectSuccessEnvelope(response.body));
  });
});

describe("POST /api/auth/logout", () => {
  it("should revoke the presented family, clear the cookie and return 204", async () => {
    const user = await seedUser({ email: "logout.patient@example.test" });
    const token = refreshTokenFrom(await login(user.email)) ?? "";

    const response = await request(apps.publicApp)
      .post("/api/auth/logout")
      .set("Cookie", cookieFor(token));

    expect(response.status).toBe(204);
    expect(response.text).toBe("");
    expect(response.headers["cache-control"]).toBe("no-store");
    expectRefreshCookie(refreshCookieHeader(response), "clear");
    const rows = await tokenRows();
    expect(rows[0]).toMatchObject({ revoked_reason: "logout" });
  });

  it("should return 204 with a clearing cookie when no cookie, a malformed one, or an unknown one is sent", async () => {
    for (const headers of [
      {},
      { Cookie: cookieFor("malformed") },
      { Cookie: cookieFor("Zm9vYmFyYmF6cXV1eGNvcmdlZ3JhdWx0Z2FycGx5Zm9v") },
    ]) {
      const response = await request(apps.publicApp).post("/api/auth/logout").set(headers);

      expect(response.status).toBe(204);
      expectRefreshCookie(refreshCookieHeader(response), "clear");
    }
  });

  it("should leave another user's and another family's tokens untouched when one family logs out", async () => {
    const owner = await seedUser({ email: "owner.patient@example.test" });
    const other = await seedUser({ email: "other.patient@example.test" });
    const ownerFirst = refreshTokenFrom(await login(owner.email)) ?? "";
    const ownerSecond = refreshTokenFrom(await login(owner.email)) ?? "";
    const otherToken = refreshTokenFrom(await login(other.email)) ?? "";

    await request(apps.publicApp).post("/api/auth/logout").set("Cookie", cookieFor(ownerFirst));

    expect((await refreshWith(ownerFirst)).status).toBe(401);
    expect((await refreshWith(ownerSecond)).status).toBe(200);
    expect((await refreshWith(otherToken)).status).toBe(200);
  });

  it("should revoke every live token of the family when a rotated token is presented", async () => {
    const user = await seedUser({ email: "logoutchain.patient@example.test" });
    const first = refreshTokenFrom(await login(user.email)) ?? "";
    await refreshWith(first);

    const response = await request(apps.publicApp)
      .post("/api/auth/logout")
      .set("Cookie", cookieFor(first));

    expect(response.status).toBe(204);
    const rows = await tokenRows();
    expect(rows.map((row) => row.revoked_reason)).toEqual(["rotated", "logout"]);
  });
});
