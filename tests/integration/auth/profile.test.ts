import type { Express } from "express";
import request from "supertest";
import { db } from "../../../src/lib/knex/knex";
import { buildTestApps } from "../../helpers/app";
import { seedUser, setStatus, softDelete } from "../../helpers/auth";
import {
  expectErrorEnvelope,
  expectSuccessEnvelope,
  expectUserPayload,
} from "../../helpers/contract";
import { closeDb, truncateAll } from "../../helpers/db";
import { closeRedis, flushTestKeys } from "../../helpers/redis";
import {
  signAccessToken,
  signExpiredAccessToken,
  signServiceTypedToken,
  tamperToken,
} from "../../helpers/tokens";

let apps: { publicApp: Express; internalApp: Express };

function getMe(token?: string): request.Test {
  const call = request(apps.publicApp).get("/api/auth/me");
  return token === undefined ? call : call.set("Authorization", `Bearer ${token}`);
}

function patchMe(token: string, body: object): request.Test {
  return request(apps.publicApp)
    .patch("/api/auth/me")
    .set("Authorization", `Bearer ${token}`)
    .send(body);
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

describe("GET /api/auth/me", () => {
  it("should return the caller's account for a pending, active or rejected status", async () => {
    for (const [role, status] of [
      ["patient", "active"],
      ["doctor", "pending"],
      ["doctor", "rejected"],
      ["admin", "active"],
    ] as const) {
      const user = await seedUser({ email: `${role}.${status}@example.test`, role, status });
      const token = await signAccessToken(user);

      const response = await getMe(token);

      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const payload = expectUserPayload(expectSuccessEnvelope(response.body));
      expect(payload).toMatchObject({ id: user.id, email: user.email, role, status });
    }
  });

  it("should never carry the password hash or any secret in the body", async () => {
    const user = await seedUser({ email: "secrets.me@example.test" });

    const response = await getMe(await signAccessToken(user));

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("$argon2");
    expect(serialized).not.toContain("passwordHash");
    expect(serialized).not.toContain("deletedAt");
  });

  it("should return 401 Unauthorized when no bearer token is presented", async () => {
    const response = await getMe();

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, "Unauthorized");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("should return 401 TokenExpired for an expired token and 401 Unauthorized for a tampered one", async () => {
    const user = await seedUser({ email: "tokens.me@example.test" });

    const expired = await getMe(await signExpiredAccessToken(user));
    const tampered = await getMe(tamperToken(await signAccessToken(user)));

    expect(expired.status).toBe(401);
    expectErrorEnvelope(expired.body, "TokenExpired");
    expect(tampered.status).toBe(401);
    expectErrorEnvelope(tampered.body, "Unauthorized");
  });

  it("should return 401 Unauthorized when a service-typed token is presented on a user route", async () => {
    const response = await getMe(await signServiceTypedToken());

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, "Unauthorized");
  });

  it("should never trust an identity header when no bearer token is sent", async () => {
    const user = await seedUser({ email: "headers.me@example.test" });

    const response = await request(apps.publicApp)
      .get("/api/auth/me")
      .set("X-User-Id", String(user.id))
      .set("X-Role", "admin");

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, "Unauthorized");
  });

  it("should return 403 AccountSuspended when the live row is suspended but the token is still valid", async () => {
    const user = await seedUser({ email: "suspended.me@example.test" });
    const token = await signAccessToken(user);
    await setStatus(user.id, "suspended");

    const response = await getMe(token);

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, "AccountSuspended");
  });

  it("should return 403 AccountSuspended when the token itself carries the suspended status", async () => {
    const user = await seedUser({ email: "suspendedclaim.me@example.test", status: "suspended" });

    const response = await getMe(await signAccessToken(user));

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, "AccountSuspended");
  });

  it("should return 401 Unauthorized when the account was soft-deleted after the token was issued", async () => {
    const user = await seedUser({ email: "deleted.me@example.test" });
    const token = await signAccessToken(user);
    await softDelete(user.id);

    const response = await getMe(token);

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, "Unauthorized");
  });

  it("should return the caller's own account only, never another user's", async () => {
    const owner = await seedUser({ email: "owner.me@example.test" });
    const other = await seedUser({ email: "other.me@example.test" });

    const response = await getMe(await signAccessToken(other));

    const payload = expectUserPayload(expectSuccessEnvelope(response.body));
    expect(payload.id).toBe(other.id);
    expect(payload.email).toBe(other.email);
    expect(payload.id).not.toBe(owner.id);
  });
});

describe("PATCH /api/auth/me", () => {
  it("should update only the provided fields and bump updatedAt when the patch is valid", async () => {
    const user = await seedUser({ email: "patch.me@example.test", phone: "+201000000001" });
    const token = await signAccessToken(user);

    const response = await patchMe(token, { fullName: "  Amira H. Hassan  " });

    expect(response.status).toBe(200);
    const payload = expectUserPayload(expectSuccessEnvelope(response.body));
    expect(payload).toMatchObject({
      fullName: "Amira H. Hassan",
      phone: "+201000000001",
      timezone: "Africa/Cairo",
      locale: "ar-EG",
      email: user.email,
    });
    expect(new Date(String(payload.updatedAt)).getTime()).toBeGreaterThan(user.updatedAt.getTime());
  });

  it("should canonicalise the timezone and locale when they are patched in another case", async () => {
    const user = await seedUser({ email: "canonical.me@example.test" });

    const response = await patchMe(await signAccessToken(user), {
      timezone: "america/new_york",
      locale: "en-us",
    });

    expect(expectSuccessEnvelope(response.body)).toMatchObject({
      timezone: "America/New_York",
      locale: "en-US",
    });
  });

  it("should clear phone and avatarUrl when null is sent", async () => {
    const user = await seedUser({ email: "clear.me@example.test", phone: "+201000000001" });
    const token = await signAccessToken(user);
    await patchMe(token, { avatarUrl: "https://cdn.example.test/a.png" });

    const response = await patchMe(token, { phone: null, avatarUrl: null });

    expect(expectSuccessEnvelope(response.body)).toMatchObject({ phone: null, avatarUrl: null });
    const row = await db("users").select("phone", "avatar_url").where("id", user.id).first<Record<string, unknown> | undefined>();
    expect(row).toEqual({ phone: null, avatar_url: null });
  });

  it("should return 400 is not allowed when email, role, status or an unknown property is sent", async () => {
    const user = await seedUser({ email: "forbidden.me@example.test" });
    const token = await signAccessToken(user);

    for (const body of [
      { email: "new@example.test" },
      { role: "admin" },
      { status: "active" },
      { fullName: "Amira", nickname: "Mira" },
    ]) {
      const response = await patchMe(token, body);

      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, "ValidationFailed");
      const details = (response.body as { error: { details: { issue: string }[] } }).error.details;
      expect(details.some((detail) => detail.issue === "is not allowed")).toBe(true);
    }
    const row = await db("users").select("email", "role", "status").where("id", user.id).first<Record<string, unknown> | undefined>();
    expect(row).toMatchObject({ email: user.email, role: "patient", status: "active" });
  });

  it("should return 400 when the body is empty, the name is blank, or the timezone or locale is invalid", async () => {
    const user = await seedUser({ email: "invalid.me@example.test" });
    const token = await signAccessToken(user);

    const empty = await patchMe(token, {});
    expect(empty.status).toBe(400);
    expect((empty.body as { error: { details: unknown[] } }).error.details).toEqual([
      { field: "body", issue: "must contain at least one property" },
    ]);

    for (const body of [
      { fullName: "   " },
      { timezone: "Mars/Olympus" },
      { locale: "not a locale" },
      { phone: "01000000001" },
      { avatarUrl: "ftp://example.test/a.png" },
    ]) {
      const response = await patchMe(token, body);
      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, "ValidationFailed");
    }
  });

  it("should return 400 ValidationFailed on the timezone field when it is a fixed UTC offset", async () => {
    const user = await seedUser({ email: "offset.me@example.test" });
    const token = await signAccessToken(user);

    for (const timezone of ["+01:00", "-05:00", "GMT+1"]) {
      const response = await patchMe(token, { timezone });
      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, "ValidationFailed");
      expect((response.body as { error: { details: { field: string }[] } }).error.details[0]?.field).toBe("timezone");
    }
    const row = await db("users").select("timezone").where("id", user.id).first<Record<string, unknown> | undefined>();
    expect(row?.timezone).toBe("Africa/Cairo");
  });

  it("should return 403 AccountSuspended and change nothing when the row is suspended", async () => {
    const user = await seedUser({ email: "suspended.patch@example.test" });
    const token = await signAccessToken(user);
    await setStatus(user.id, "suspended");

    const response = await patchMe(token, { fullName: "Changed Name" });

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, "AccountSuspended");
    const row = await db("users").select("full_name").where("id", user.id).first<Record<string, unknown> | undefined>();
    expect(row?.full_name).toBe("Amira Hassan");
  });

  it("should return 401 Unauthorized when the account was soft-deleted after the token was issued", async () => {
    const user = await seedUser({ email: "deleted.patch@example.test" });
    const token = await signAccessToken(user);
    await softDelete(user.id);

    const response = await patchMe(token, { fullName: "Changed Name" });

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, "Unauthorized");
  });

  it("should never let one account's token change another account's row", async () => {
    const owner = await seedUser({ email: "owner.patch@example.test" });
    const other = await seedUser({ email: "other.patch@example.test", fullName: "Other Person" });

    const response = await patchMe(await signAccessToken(other), { fullName: "Renamed" });

    expect(response.status).toBe(200);
    const rows = await db("users").select("id", "full_name").orderBy("id", "asc");
    expect(rows).toEqual([
      { id: String(owner.id), full_name: "Amira Hassan" },
      { id: String(other.id), full_name: "Renamed" },
    ]);
  });

  it("should return 401 Unauthorized when no token is presented", async () => {
    const response = await request(apps.publicApp).patch("/api/auth/me").send({ fullName: "X" });

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, "Unauthorized");
  });
});
