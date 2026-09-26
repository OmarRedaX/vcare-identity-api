import type { Express } from "express";
import request from "supertest";
import { MemoryCaptureEmailAdapter } from "../../../src/lib/email/memory-capture-adapter";
import { db } from "../../../src/lib/knex/knex";
import { hmacSha256Hex } from "../../../src/pkg/utils/crypto";
import { buildTestApps } from "../../helpers/app";
import {
  ageColumn,
  codeFromEmail,
  refreshTokenFrom,
  runOutbox,
  seedUser,
  TEST_PASSWORD,
  uuid,
} from "../../helpers/auth";
import { expectErrorEnvelope } from "../../helpers/contract";
import { closeDb, truncateAll } from "../../helpers/db";
import { closeRedis, flushTestKeys } from "../../helpers/redis";

const NEW_PASSWORD = "Synthetic-New-Passw0rd";

interface ResetRow {
  id: string;
  user_id: string;
  code_hash: string | null;
  attempts: number;
  expires_at: Date | null;
  used_at: Date | null;
  invalidated_at: Date | null;
}

let apps: { publicApp: Express; internalApp: Express };
let email: MemoryCaptureEmailAdapter;

function resetRows(): Promise<ResetRow[]> {
  return db<ResetRow>("password_resets").select("*").orderBy("id", "asc");
}

function forgot(address: string): Promise<request.Response> {
  return request(apps.publicApp).post("/api/auth/forgot-password").send({ email: address });
}

function reset(body: Record<string, unknown>): Promise<request.Response> {
  return request(apps.publicApp).post("/api/auth/reset-password").send(body);
}

function login(address: string, password: string): Promise<request.Response> {
  return request(apps.publicApp).post("/api/auth/login").send({ email: address, password });
}

/** Drives the real flow: forgot-password -> worker -> the code the account holder would type. */
async function requestCode(address: string): Promise<string> {
  email.clear();
  const response = await forgot(address);
  expect(response.status).toBe(204);
  await runOutbox(email);
  const message = email.messages().find((sent) => sent.to === address);
  return codeFromEmail(message?.text ?? "");
}

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
  await closeRedis();
  await closeDb();
});

describe("POST /api/auth/forgot-password", () => {
  it("should answer 204 for a known and an unknown email and write a row only for the known one", async () => {
    const user = await seedUser({ email: "forgot.patient@example.test" });

    const known = await forgot(user.email);
    const unknown = await forgot("nobody@example.test");

    expect(known.status).toBe(204);
    expect(unknown.status).toBe(204);
    expect(known.text).toBe(unknown.text);
    expect(known.headers["cache-control"]).toBe("no-store");
    expect(unknown.headers["cache-control"]).toBe("no-store");

    const rows = await resetRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: String(user.id), attempts: 0, code_hash: null });
    const jobs = await db("outbox_jobs").select("type", "aggregate_id");
    expect(jobs).toEqual([{ type: "send_password_reset", aggregate_id: rows[0]?.id }]);
  });

  it("should accept a reset request from a suspended account when it asks for one", async () => {
    const user = await seedUser({ email: "suspended.forgot@example.test", status: "suspended" });

    const response = await forgot(user.email);

    expect(response.status).toBe(204);
    expect(await resetRows()).toHaveLength(1);
  });

  it("should invalidate the earlier open row when forgot-password is called again", async () => {
    const user = await seedUser({ email: "second.forgot@example.test" });

    await forgot(user.email);
    await forgot(user.email);

    const rows = await resetRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.invalidated_at).not.toBeNull();
    expect(rows[1]?.invalidated_at).toBeNull();
  });

  it("should return 429 RateLimited on the fourth request for the same email within an hour", async () => {
    const user = await seedUser({ email: "limited.forgot@example.test" });

    for (let i = 0; i < 3; i += 1) {
      expect((await forgot(user.email)).status).toBe(204);
    }

    const denied = await forgot(user.email);

    expect(denied.status).toBe(429);
    expectErrorEnvelope(denied.body, "RateLimited");
    expect(Number(denied.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });
});

describe("the emailed reset code", () => {
  it("should be six digits, stored only as its HMAC, valid for thirty minutes and absent from any URL", async () => {
    const user = await seedUser({ email: "code.patient@example.test" });

    const code = await requestCode(user.email);

    expect(code).toMatch(/^[0-9]{6}$/);
    const [row] = await resetRows();
    expect(row?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.code_hash).toBe(hmacSha256Hex(String(process.env.OTP_PEPPER), code));
    expect(row?.attempts).toBe(0);
    const minutes = (new Date(String(row?.expires_at)).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(29);
    expect(minutes).toBeLessThanOrEqual(30);

    const [message] = email.messages();
    for (const url of message?.text.match(/https?:\/\/\S+/g) ?? []) {
      expect(url).not.toContain(code);
      expect(url).not.toContain("?");
    }
  });
});

describe("POST /api/auth/reset-password", () => {
  it("should set the new password, use the row and revoke every family when the code is correct", async () => {
    const user = await seedUser({ email: "reset.patient@example.test" });
    const session = await login(user.email, TEST_PASSWORD);
    const refreshToken = refreshTokenFrom(session) ?? "";
    const code = await requestCode(user.email);

    const response = await reset({ email: user.email, code, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(204);
    expect(response.headers["cache-control"]).toBe("no-store");

    const [row] = await resetRows();
    expect(row?.used_at).not.toBeNull();
    expect(row?.attempts).toBe(1);

    const revoked = await db("refresh_tokens").select("revoked_reason").where("user_id", user.id);
    expect(revoked).toEqual([{ revoked_reason: "password_reset" }]);
    const replayed = await request(apps.publicApp)
      .post("/api/auth/refresh")
      .set("Cookie", `vcare_rt=${refreshToken}`);
    expect(replayed.status).toBe(401);

    expect((await login(user.email, TEST_PASSWORD)).status).toBe(401);
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
    const stored = await db("users").select("status").where("id", user.id).first();
    expect(stored?.status).toBe("active");
  });

  it("should return 400 field code and count the attempt when the code is wrong", async () => {
    const user = await seedUser({ email: "wrongcode.reset@example.test" });
    await requestCode(user.email);

    const response = await reset({ email: user.email, code: "999999", newPassword: NEW_PASSWORD });

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, "ValidationFailed");
    expect((response.body as { error: { details: unknown[] } }).error.details).toEqual([
      { field: "code", issue: "is invalid or expired" },
    ]);
    const [row] = await resetRows();
    expect(row?.attempts).toBe(1);
    expect(row?.invalidated_at).toBeNull();
    expect((await login(user.email, TEST_PASSWORD)).status).toBe(200);
  });

  it("should invalidate the row and refuse even the right code after the fifth failed attempt", async () => {
    const user = await seedUser({ email: "exhausted.reset@example.test" });
    const code = await requestCode(user.email);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const failed = await reset({ email: user.email, code: "999999", newPassword: NEW_PASSWORD });
      expect(failed.status).toBe(400);
    }

    const [row] = await resetRows();
    expect(row?.attempts).toBe(5);
    expect(row?.invalidated_at).not.toBeNull();

    await flushTestKeys();
    const withRightCode = await reset({ email: user.email, code, newPassword: NEW_PASSWORD });
    expect(withRightCode.status).toBe(400);
    expect((await login(user.email, TEST_PASSWORD)).status).toBe(200);
  });

  it("should return the identical 400 field code for an expired, unsent, used or superseded row", async () => {
    const responses: request.Response[] = [];

    const expired = await seedUser({ email: "expired.reset@example.test" });
    const expiredCode = await requestCode(expired.email);
    const [expiredRow] = await resetRows();
    await ageColumn("password_resets", Number(expiredRow?.id), "expires_at", "1 minute");
    responses.push(await reset({ email: expired.email, code: expiredCode, newPassword: NEW_PASSWORD }));

    const unsent = await seedUser({ email: "unsent.reset@example.test" });
    await forgot(unsent.email);
    responses.push(await reset({ email: unsent.email, code: "123456", newPassword: NEW_PASSWORD }));

    const used = await seedUser({ email: "used.reset@example.test" });
    const usedCode = await requestCode(used.email);
    expect((await reset({ email: used.email, code: usedCode, newPassword: NEW_PASSWORD })).status).toBe(204);
    responses.push(await reset({ email: used.email, code: usedCode, newPassword: NEW_PASSWORD }));

    const superseded = await seedUser({ email: "superseded.reset@example.test" });
    const firstCode = await requestCode(superseded.email);
    const secondCode = await requestCode(superseded.email);
    expect(secondCode).toBeDefined();
    responses.push(await reset({ email: superseded.email, code: firstCode, newPassword: NEW_PASSWORD }));

    for (const response of responses) {
      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, "ValidationFailed");
      expect((response.body as { error: { details: unknown[] } }).error.details).toEqual([
        { field: "code", issue: "is invalid or expired" },
      ]);
    }
  });

  it("should answer an unknown email exactly as a wrong code and write no row for it", async () => {
    const user = await seedUser({ email: "enumeration.reset@example.test" });
    await requestCode(user.email);

    const wrongCode = await reset({ email: user.email, code: "999999", newPassword: NEW_PASSWORD });
    const unknownEmail = await reset({
      email: "nobody@example.test",
      code: "999999",
      newPassword: NEW_PASSWORD,
    });

    expect(unknownEmail.status).toBe(wrongCode.status);
    expect({ ...unknownEmail.body.error, requestId: null }).toEqual({
      ...wrongCode.body.error,
      requestId: null,
    });
    expect(unknownEmail.headers["cache-control"]).toBe(wrongCode.headers["cache-control"]);
    expect(await resetRows()).toHaveLength(1);
  });

  it("should return 400 field code when the code belongs to another user's row", async () => {
    const owner = await seedUser({ email: "owner.reset@example.test" });
    const stranger = await seedUser({ email: "stranger.reset@example.test" });
    const ownerCode = await requestCode(owner.email);
    await requestCode(stranger.email);

    const response = await reset({
      email: stranger.email,
      code: ownerCode,
      newPassword: NEW_PASSWORD,
    });

    // A collision of two random six-digit codes would make this assertion meaningless.
    const strangerRow = (await resetRows()).find((row) => row.user_id === String(stranger.id));
    if (strangerRow?.code_hash === hmacSha256Hex(String(process.env.OTP_PEPPER), ownerCode)) {
      return;
    }
    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, "ValidationFailed");
    expect((await login(stranger.email, TEST_PASSWORD)).status).toBe(200);
  });

  it("should reject a code that is not six digits before any database work", async () => {
    const user = await seedUser({ email: "shape.reset@example.test" });
    await requestCode(user.email);

    const response = await reset({ email: user.email, code: "12345", newPassword: NEW_PASSWORD });

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, "ValidationFailed");
    expect((response.body as { error: { details: { field: string }[] } }).error.details[0]?.field).toBe(
      "code",
    );
    const [row] = await resetRows();
    expect(row?.attempts).toBe(0);
  });

  it("should return 400 when the new password is too short or on the denylist", async () => {
    const user = await seedUser({ email: "weak.reset@example.test" });
    const code = await requestCode(user.email);

    const short = await reset({ email: user.email, code, newPassword: "Short1!" });
    const common = await reset({ email: user.email, code, newPassword: "password123" });

    expect(short.status).toBe(400);
    expect(common.status).toBe(400);
    expectErrorEnvelope(common.body, "ValidationFailed");
    expect(
      (common.body as { error: { details: { field: string; issue: string }[] } }).error.details,
    ).toEqual([{ field: "newPassword", issue: "is too common" }]);
    const [row] = await resetRows();
    expect(row?.attempts).toBe(0);
  });

  it("should reset a suspended account's password and still refuse its login", async () => {
    const user = await seedUser({ email: "suspended.reset@example.test", status: "suspended" });
    const code = await requestCode(user.email);

    const response = await reset({ email: user.email, code, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(204);
    const attempt = await login(user.email, NEW_PASSWORD);
    expect(attempt.status).toBe(403);
    expectErrorEnvelope(attempt.body, "AccountSuspended");
  });

  it("should return 429 RateLimited on the sixth reset attempt for the same email within an hour", async () => {
    const user = await seedUser({ email: "limited.reset@example.test" });
    await requestCode(user.email);

    for (let i = 0; i < 5; i += 1) {
      const failed = await reset({ email: user.email, code: "999999", newPassword: NEW_PASSWORD });
      expect(failed.status).toBe(400);
    }

    const denied = await reset({ email: user.email, code: "999999", newPassword: NEW_PASSWORD });

    expect(denied.status).toBe(429);
    expectErrorEnvelope(denied.body, "RateLimited");
    expect(Number(denied.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("should replay the stored 204 when the same Idempotency-Key and body are resent", async () => {
    const user = await seedUser({ email: "idem.reset@example.test" });
    const code = await requestCode(user.email);
    const key = uuid();
    const body = { email: user.email, code, newPassword: NEW_PASSWORD };

    const first = await request(apps.publicApp)
      .post("/api/auth/reset-password")
      .set("Idempotency-Key", key)
      .send(body);
    const replay = await request(apps.publicApp)
      .post("/api/auth/reset-password")
      .set("Idempotency-Key", key)
      .send(body);
    const conflicting = await request(apps.publicApp)
      .post("/api/auth/reset-password")
      .set("Idempotency-Key", key)
      .send({ ...body, newPassword: "Another-Synthetic-Passw0rd" });

    expect(first.status).toBe(204);
    expect(replay.status).toBe(204);
    expect(conflicting.status).toBe(422);
    expectErrorEnvelope(conflicting.body, "IdempotencyConflict");
  });

  it("should never carry a code, a hash or a token in any password-flow response", async () => {
    const user = await seedUser({ email: "secrets.reset@example.test" });
    const code = await requestCode(user.email);

    const forgotten = await forgot(user.email);
    const failed = await reset({ email: user.email, code: "999999", newPassword: NEW_PASSWORD });

    for (const response of [forgotten, failed]) {
      const serialized = `${JSON.stringify(response.body)}${response.text}`;
      expect(serialized).not.toContain(code);
      expect(serialized).not.toContain("$argon2");
      expect(serialized).not.toContain("codeHash");
      expect(serialized).not.toContain(NEW_PASSWORD);
    }
  });
});
