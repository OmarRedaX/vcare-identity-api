import type { Express } from "express";
import request from "supertest";
import { MemoryCaptureEmailAdapter } from "../../../src/lib/email/memory-capture-adapter";
import { db } from "../../../src/lib/knex/knex";
import { logger } from "../../../src/lib/logger/logger";
import { buildTestApps } from "../../helpers/app";
import {
  codeFromEmail,
  refreshTokenFrom,
  runOutbox,
  seedUser,
  TEST_PASSWORD,
  uuid,
  cookieFor,
} from "../../helpers/auth";
import { expectErrorEnvelope } from "../../helpers/contract";
import { closeDb, truncateAll } from "../../helpers/db";
import { captureLogs } from "../../helpers/log-capture";
import { closeRedis, flushTestKeys } from "../../helpers/redis";
import { signAccessToken } from "../../helpers/tokens";

const NEW_PASSWORD = "Synthetic-New-Passw0rd";

let apps: { publicApp: Express; internalApp: Express };
let email: MemoryCaptureEmailAdapter;

beforeAll(() => {
  email = new MemoryCaptureEmailAdapter();
  apps = buildTestApps({ overrides: { emailPort: email } });
});

beforeEach(async () => {
  await truncateAll();
  await flushTestKeys();
  email.clear();
});

afterAll(async () => {
  logger.setLevel("warn");
  await closeRedis();
  await closeDb();
});

describe("RBAC on the bearer-token auth routes", () => {
  it("should serve GET /me, PATCH /me and change-password when the caller is a patient, a doctor or an admin", async () => {
    for (const role of ["patient", "doctor", "admin"] as const) {
      const user = await seedUser({ email: `rbac.${role}@example.test`, role, status: "active" });
      const token = await signAccessToken(user);

      const me = await request(apps.publicApp).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
      const patched = await request(apps.publicApp)
        .patch("/api/auth/me")
        .set("Authorization", `Bearer ${token}`)
        .send({ timezone: "Europe/Berlin" });
      const changed = await request(apps.publicApp)
        .post("/api/auth/change-password")
        .set("Authorization", `Bearer ${token}`)
        .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      expect([me.status, patched.status, changed.status]).toEqual([200, 200, 204]);
      expect((me.body as { data: { id: number; role: string } }).data).toMatchObject({
        id: user.id,
        role,
      });
    }
  });

  it("should answer 401 on every bearer route when no token is sent", async () => {
    const calls = [
      request(apps.publicApp).get("/api/auth/me"),
      request(apps.publicApp).patch("/api/auth/me").send({ timezone: "Europe/Berlin" }),
      request(apps.publicApp)
        .post("/api/auth/change-password")
        .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }),
    ];

    for (const call of calls) {
      const response = await call;
      expect(response.status).toBe(401);
      expectErrorEnvelope(response.body, "Unauthorized");
    }
  });

  it("should not authenticate refresh or logout by an access token when no refresh cookie is sent", async () => {
    const user = await seedUser({ email: "bearer.only@example.test" });
    const token = await signAccessToken(user);

    const refreshed = await request(apps.publicApp)
      .post("/api/auth/refresh")
      .set("Authorization", `Bearer ${token}`);

    expect(refreshed.status).toBe(401);
    expectErrorEnvelope(refreshed.body, "RefreshTokenInvalid");
    expect(await db("refresh_tokens").count("* as n").first()).toMatchObject({ n: "0" });
  });

  it("should refuse another user's refresh cookie on logout without touching the caller's session", async () => {
    const owner = await seedUser({ email: "owner.session@example.test" });
    const other = await seedUser({ email: "other.session@example.test" });
    const ownerLogin = await request(apps.publicApp)
      .post("/api/auth/login")
      .send({ email: owner.email, password: TEST_PASSWORD });
    const otherLogin = await request(apps.publicApp)
      .post("/api/auth/login")
      .send({ email: other.email, password: TEST_PASSWORD });

    await request(apps.publicApp)
      .post("/api/auth/logout")
      .set("Cookie", cookieFor(refreshTokenFrom(otherLogin) ?? ""));

    const live = await db("refresh_tokens").whereNull("revoked_at").select("user_id");
    expect(live).toEqual([{ user_id: String(owner.id) }]);
    expect(refreshTokenFrom(ownerLogin)).toBeDefined();
  });
});

describe("privacy across a full account lifecycle", () => {
  const PII = {
    email: "zainab.logleak@example.test",
    fullName: "Zainab Logleak",
    renamed: "Zainab Renamedleak",
    phone: "+201005550123",
    password: "Logleak-Passw0rd-Fixture",
    newPassword: "Logleak-NewPassw0rd-Fixture",
    resetPassword: "Logleak-ResetPassw0rd-Fixture",
  };

  async function codeFor(address: string, kind: "start" | "forgot"): Promise<string> {
    email.clear();
    const path = kind === "start" ? "/api/auth/register/start" : "/api/auth/forgot-password";
    await request(apps.publicApp).post(path).send({ email: address });
    await runOutbox(email);
    return codeFromEmail(email.messages().find((sent) => sent.to === address)?.text ?? "");
  }

  it("should log no PII, secret or code and return no secret column when an account registers, signs in, changes and resets its password", async () => {
    const capture = captureLogs();
    const bodies: string[] = [];
    const secrets: string[] = [];
    const record = (response: request.Response): request.Response => {
      bodies.push(JSON.stringify(response.body));
      return response;
    };

    try {
      const registrationCode = await codeFor(PII.email, "start");
      const completed = record(
        await request(apps.publicApp)
          .post("/api/auth/register/complete")
          .set("Idempotency-Key", uuid())
          .send({
            email: PII.email,
            code: registrationCode,
            password: PII.password,
            fullName: PII.fullName,
            phone: PII.phone,
            role: "patient",
            timezone: "Africa/Cairo",
            locale: "ar-EG",
          }),
      );
      expect(completed.status).toBe(201);

      record(
        await request(apps.publicApp)
          .post("/api/auth/login")
          .send({ email: PII.email, password: "Wrong-Passw0rd-Fixture" }),
      );
      const signedIn = record(
        await request(apps.publicApp)
          .post("/api/auth/login")
          .send({ email: PII.email, password: PII.password }),
      );
      expect(signedIn.status).toBe(200);
      const accessToken = (signedIn.body as { data: { accessToken: string } }).data.accessToken;
      const refreshToken = refreshTokenFrom(signedIn) ?? "";
      secrets.push(accessToken, refreshToken);

      const refreshed = record(
        await request(apps.publicApp).post("/api/auth/refresh").set("Cookie", cookieFor(refreshToken)),
      );
      expect(refreshed.status).toBe(200);
      secrets.push((refreshed.body as { data: { accessToken: string } }).data.accessToken);
      const rotated = refreshTokenFrom(refreshed) ?? "";
      secrets.push(rotated);

      record(
        await request(apps.publicApp)
          .get("/api/auth/me")
          .set("Authorization", `Bearer ${accessToken}`),
      );
      record(
        await request(apps.publicApp)
          .patch("/api/auth/me")
          .set("Authorization", `Bearer ${accessToken}`)
          .send({ fullName: PII.renamed }),
      );
      const changed = record(
        await request(apps.publicApp)
          .post("/api/auth/change-password")
          .set("Authorization", `Bearer ${accessToken}`)
          .set("Cookie", cookieFor(rotated))
          .send({ currentPassword: PII.password, newPassword: PII.newPassword }),
      );
      expect(changed.status).toBe(204);

      const resetCode = await codeFor(PII.email, "forgot");
      const reset = record(
        await request(apps.publicApp)
          .post("/api/auth/reset-password")
          .send({ email: PII.email, code: resetCode, newPassword: PII.resetPassword }),
      );
      expect(reset.status).toBe(204);
      record(await request(apps.publicApp).post("/api/auth/logout").set("Cookie", cookieFor(rotated)));

      const logs = capture.text();
      const forbidden = [
        PII.email,
        PII.fullName,
        PII.renamed,
        PII.phone,
        PII.password,
        PII.newPassword,
        PII.resetPassword,
        "Wrong-Passw0rd-Fixture",
        ...secrets,
      ];
      for (const value of forbidden) {
        expect(logs).not.toContain(value);
      }
      for (const code of [registrationCode, resetCode]) {
        expect(logs).not.toMatch(new RegExp(`\\b${code}\\b`));
      }
      expect(logs).not.toMatch(/\$argon2/);
      expect(logs.length).toBeGreaterThan(0);
    } finally {
      capture.restore();
    }

    const everyBody = bodies.join("\n");
    for (const value of [...secrets.slice(2).filter((s) => s.length > 0 && !s.includes(".")), "$argon2"]) {
      expect(everyBody).not.toContain(value);
    }
    expect(everyBody).not.toMatch(/passwordHash|password_hash|tokenHash|token_hash|codeHash|code_hash/);
    expect(everyBody).not.toContain(PII.password);
    expect(everyBody).not.toContain(PII.newPassword);
  });

  it("should hold ids and request ids only in outbox rows before and after the worker delivers a reset code", async () => {
    const user = await seedUser({ email: PII.email, fullName: PII.fullName, phone: PII.phone });
    await request(apps.publicApp).post("/api/auth/forgot-password").send({ email: user.email });

    const before = JSON.stringify(await db("outbox_jobs").select("*"));
    await runOutbox(email);
    const afterRows = await db("outbox_jobs").select("*");
    const after = JSON.stringify(afterRows);
    const code = codeFromEmail(email.messages()[0]?.text ?? "");

    expect(afterRows).toHaveLength(1);
    for (const serialized of [before, after]) {
      expect(serialized).not.toContain("example.test");
      expect(serialized).not.toContain(PII.fullName);
      expect(serialized).not.toContain(PII.phone);
      expect(serialized).not.toMatch(new RegExp(`\\b${code}\\b`));
    }
    expect(afterRows[0]).toMatchObject({ last_error: null });
  });
});
