import type { Express } from "express";
import request from "supertest";
import { MemoryCaptureEmailAdapter } from "../../../src/lib/email/memory-capture-adapter";
import { db } from "../../../src/lib/knex/knex";
import { buildTestApps } from "../../helpers/app";
import {
  ageColumn,
  codeFromEmail,
  refreshCookieHeader,
  runOutbox,
  seedUser,
  TEST_PASSWORD,
  uuid,
} from "../../helpers/auth";
import {
  expectErrorEnvelope,
  expectSuccessEnvelope,
  expectUserPayload,
} from "../../helpers/contract";
import { closeDb, truncateAll } from "../../helpers/db";
import { closeRedis, flushTestKeys } from "../../helpers/redis";

let apps: { publicApp: Express; internalApp: Express };
let email: MemoryCaptureEmailAdapter;

interface ChallengeRow {
  id: string;
  email: string;
  code_hash: string | null;
  attempts: number;
  expires_at: Date | null;
  consumed_at: Date | null;
  invalidated_at: Date | null;
}

interface OutboxRow {
  id: string;
  type: string;
  aggregate_id: string;
  status: string;
  attempts: number;
  request_id: string;
  last_error: string | null;
}

function completeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: "amira.patient@example.test",
    code: "000000",
    password: TEST_PASSWORD,
    fullName: "Amira Hassan",
    role: "patient",
    timezone: "Africa/Cairo",
    locale: "ar-EG",
    ...overrides,
  };
}

/** Drives the real flow: start -> worker -> the code the account holder would type. */
async function startAndReadCode(address: string): Promise<string> {
  email.clear();
  const started = await request(apps.publicApp).post("/api/auth/register/start").send({ email: address });
  expect(started.status).toBe(202);
  await runOutbox(email);
  const message = email.messages().find((sent) => sent.to === address);
  return codeFromEmail(message?.text ?? "");
}

function challengesFor(address: string): Promise<ChallengeRow[]> {
  return db<ChallengeRow>("registration_challenges")
    .select("*")
    .where("email", address)
    .orderBy("created_at", "asc");
}

function outboxRows(): Promise<OutboxRow[]> {
  return db<OutboxRow>("outbox_jobs").select("*").orderBy("id", "asc");
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

describe("POST /api/auth/register/start", () => {
  it("should return 202 with no body and create a challenge and a code job when the email is unknown", async () => {
    const address = "unknown.patient@example.test";

    const response = await request(apps.publicApp)
      .post("/api/auth/register/start")
      .send({ email: address });

    expect(response.status).toBe(202);
    expect(response.text).toBe("");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);

    const challenges = await challengesFor(address);
    expect(challenges).toHaveLength(1);
    expect(challenges[0]).toMatchObject({ code_hash: null, attempts: 0, expires_at: null });

    const jobs = await outboxRows();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: "send_registration_code",
      status: "pending",
      attempts: 0,
      aggregate_id: challenges[0]?.id,
    });
    expect(jobs[0]?.request_id).toBe(response.headers["x-request-id"]);
  });

  it("should leave exactly one open challenge when two register/start calls for the same email run concurrently", async () => {
    const address = "racing.patient@example.test";

    const responses = await Promise.all([
      request(apps.publicApp).post("/api/auth/register/start").send({ email: address }),
      request(apps.publicApp).post("/api/auth/register/start").send({ email: address }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    const rows = await challengesFor(address);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.invalidated_at === null && row.consumed_at === null)).toHaveLength(1);
  });

  it("should answer identically and enqueue only a notice when the email belongs to a live account", async () => {
    const address = "known.patient@example.test";
    await seedUser({ email: address });

    const known = await request(apps.publicApp)
      .post("/api/auth/register/start")
      .send({ email: address });
    const unknown = await request(apps.publicApp)
      .post("/api/auth/register/start")
      .send({ email: "other.patient@example.test" });

    expect(known.status).toBe(unknown.status);
    expect(known.text).toBe(unknown.text);
    expect(known.headers["cache-control"]).toBe(unknown.headers["cache-control"]);
    expect(Object.keys(known.headers).sort()).toEqual(Object.keys(unknown.headers).sort());

    expect(await challengesFor(address)).toHaveLength(0);
    const jobs = await outboxRows();
    expect(jobs.map((job) => job.type)).toEqual([
      "send_account_exists_notice",
      "send_registration_code",
    ]);
  });

  it("should take the same time for a known and an unknown email when both are submitted", async () => {
    const known = "timing.known@example.test";
    const user = await seedUser({ email: known });
    expect(user.id).toBeGreaterThan(0);

    const measure = async (address: string): Promise<number> => {
      await flushTestKeys();
      const started = process.hrtime.bigint();
      await request(apps.publicApp).post("/api/auth/register/start").send({ email: address });
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    const knownTimes: number[] = [];
    const unknownTimes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      knownTimes.push(await measure(known));
      unknownTimes.push(await measure(`timing.unknown-${String(i)}@example.test`));
    }
    const median = (values: number[]): number =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

    expect(Math.abs(median(knownTimes) - median(unknownTimes))).toBeLessThan(150);
  });

  it("should invalidate the earlier open challenge when register/start is called again", async () => {
    const address = "resend.patient@example.test";

    await request(apps.publicApp).post("/api/auth/register/start").send({ email: address });
    await request(apps.publicApp).post("/api/auth/register/start").send({ email: address });

    const challenges = await challengesFor(address);
    expect(challenges).toHaveLength(2);
    expect(challenges[0]?.invalidated_at).not.toBeNull();
    expect(challenges[1]?.invalidated_at).toBeNull();
  });

  it("should replay the stored 202 and send no second email when the same Idempotency-Key is reused", async () => {
    const address = "idem.patient@example.test";
    const key = uuid();

    const first = await request(apps.publicApp)
      .post("/api/auth/register/start")
      .set("Idempotency-Key", key)
      .send({ email: address });
    const replay = await request(apps.publicApp)
      .post("/api/auth/register/start")
      .set("Idempotency-Key", key)
      .send({ email: address });

    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(await challengesFor(address)).toHaveLength(1);
    expect(await outboxRows()).toHaveLength(1);
  });

  it("should return 422 IdempotencyConflict when the same key is sent with a different body", async () => {
    const key = uuid();
    await request(apps.publicApp)
      .post("/api/auth/register/start")
      .set("Idempotency-Key", key)
      .send({ email: "first.patient@example.test" });

    const conflicting = await request(apps.publicApp)
      .post("/api/auth/register/start")
      .set("Idempotency-Key", key)
      .send({ email: "second.patient@example.test" });

    expect(conflicting.status).toBe(422);
    expectErrorEnvelope(conflicting.body, "IdempotencyConflict");
    expect(conflicting.headers["cache-control"]).toBe("no-store");
  });

  it("should return 400 ValidationFailed when the email is malformed or missing", async () => {
    const response = await request(apps.publicApp)
      .post("/api/auth/register/start")
      .send({ email: "not-an-email" });

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, "ValidationFailed");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(await outboxRows()).toHaveLength(0);
  });

  it("should return 429 with Retry-After on the fourth start for the same email within an hour", async () => {
    const address = "limited.patient@example.test";

    for (let i = 0; i < 3; i += 1) {
      const allowed = await request(apps.publicApp)
        .post("/api/auth/register/start")
        .send({ email: address });
      expect(allowed.status).toBe(202);
    }

    const denied = await request(apps.publicApp)
      .post("/api/auth/register/start")
      .send({ email: address });

    expect(denied.status).toBe(429);
    expectErrorEnvelope(denied.body, "RateLimited");
    expect(Number(denied.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(denied.headers["cache-control"]).toBe("no-store");
    expect(await challengesFor(address)).toHaveLength(3);
  });
});

describe("POST /api/auth/register/complete", () => {
  it("should return 400 ValidationFailed on the timezone field when it is a fixed UTC offset", async () => {
    for (const timezone of ["+01:00", "-05:00", "GMT+1"]) {
      const response = await request(apps.publicApp)
        .post("/api/auth/register/complete")
        .set("Idempotency-Key", uuid())
        .send(completeBody({ timezone }));

      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, "ValidationFailed");
      expect((response.body as { error: { details: { field: string }[] } }).error.details[0]?.field).toBe("timezone");
    }
  });

  it("should create an active patient with a verified email when the code is correct", async () => {
    const address = "amira.patient@example.test";
    const code = await startAndReadCode(address);

    const response = await request(apps.publicApp)
      .post("/api/auth/register/complete")
      .set("Idempotency-Key", uuid())
      .send(completeBody({ email: address, code, phone: "+201000000001" }));

    expect(response.status).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    const user = expectUserPayload(expectSuccessEnvelope(response.body));
    expect(user).toMatchObject({
      email: address,
      role: "patient",
      status: "active",
      phone: "+201000000001",
      timezone: "Africa/Cairo",
      locale: "ar-EG",
    });
    expect(user.emailVerifiedAt).not.toBeNull();

    expect(refreshCookieHeader(response)).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain("accessToken");

    const challenges = await challengesFor(address);
    expect(challenges[0]?.consumed_at).not.toBeNull();
    expect(challenges[0]?.attempts).toBe(1);
  });

  it("should create a pending doctor when the role is doctor", async () => {
    const address = "doctor.applicant@example.test";
    const code = await startAndReadCode(address);

    const response = await request(apps.publicApp)
      .post("/api/auth/register/complete")
      .set("Idempotency-Key", uuid())
      .send(completeBody({ email: address, code, role: "doctor" }));

    expect(response.status).toBe(201);
    expect(expectSuccessEnvelope(response.body)).toMatchObject({ role: "doctor", status: "pending" });
  });

  it("should store the timezone and locale in canonical form when they are sent in another case", async () => {
    const address = "canonical.patient@example.test";
    const code = await startAndReadCode(address);

    const response = await request(apps.publicApp)
      .post("/api/auth/register/complete")
      .set("Idempotency-Key", uuid())
      .send(completeBody({ email: address, code, timezone: "africa/cairo", locale: "ar-eg" }));

    expect(expectSuccessEnvelope(response.body)).toMatchObject({
      timezone: "Africa/Cairo",
      locale: "ar-EG",
    });
    const row = await db("users").select("timezone", "locale").where("email", address).first<Record<string, unknown> | undefined>();
    expect(row).toEqual({ timezone: "Africa/Cairo", locale: "ar-EG" });
  });

  it("should return 400 ValidationFailed when the role is admin", async () => {
    const address = "sneaky.admin@example.test";
    const code = await startAndReadCode(address);

    const response = await request(apps.publicApp)
      .post("/api/auth/register/complete")
      .set("Idempotency-Key", uuid())
      .send(completeBody({ email: address, code, role: "admin" }));

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, "ValidationFailed");
    expect(await db("users").count({ count: "*" }).first()).toMatchObject({ count: "0" });
  });

  it("should return the same 400 field code and count the attempt when the code is wrong", async () => {
    const address = "wrongcode.patient@example.test";
    await startAndReadCode(address);

    const response = await request(apps.publicApp)
      .post("/api/auth/register/complete")
      .set("Idempotency-Key", uuid())
      .send(completeBody({ email: address, code: "999999" }));

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, "ValidationFailed");
    expect((response.body as { error: { details: unknown[] } }).error.details).toEqual([
      { field: "code", issue: "is invalid or expired" },
    ]);
    const challenges = await challengesFor(address);
    expect(challenges[0]?.attempts).toBe(1);
    expect(challenges[0]?.invalidated_at).toBeNull();
  });

  it("should invalidate the challenge and refuse even the right code after the fifth failure", async () => {
    const address = "exhausted.patient@example.test";
    const code = await startAndReadCode(address);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const failed = await request(apps.publicApp)
        .post("/api/auth/register/complete")
        .set("Idempotency-Key", uuid())
        .send(completeBody({ email: address, code: "999999" }));
      expect(failed.status).toBe(400);
    }

    const challenges = await challengesFor(address);
    expect(challenges[0]?.attempts).toBe(5);
    expect(challenges[0]?.invalidated_at).not.toBeNull();

    const withRightCode = await request(apps.publicApp)
      .post("/api/auth/register/complete")
      .set("Idempotency-Key", uuid())
      .send(completeBody({ email: address, code }));

    expect(withRightCode.status).toBe(400);
    expectErrorEnvelope(withRightCode.body, "ValidationFailed");
    expect(await db("users").count({ count: "*" }).first()).toMatchObject({ count: "0" });
  });

  it("should return an identical 400 field code for an expired, unsent, consumed or missing challenge", async () => {
    const bodies: (() => Promise<request.Response>)[] = [
      // expired
      async () => {
        const address = "expired.patient@example.test";
        const code = await startAndReadCode(address);
        const [challenge] = await challengesFor(address);
        await ageColumn("registration_challenges", Number(challenge?.id), "expires_at", "1 minute");
        return request(apps.publicApp)
          .post("/api/auth/register/complete")
          .set("Idempotency-Key", uuid())
          .send(completeBody({ email: address, code }));
      },
      // never sent (the worker has not run yet)
      async () => {
        const address = "unsent.patient@example.test";
        await request(apps.publicApp).post("/api/auth/register/start").send({ email: address });
        return request(apps.publicApp)
          .post("/api/auth/register/complete")
          .set("Idempotency-Key", uuid())
          .send(completeBody({ email: address, code: "123456" }));
      },
      // consumed: the same code used twice
      async () => {
        const address = "consumed.patient@example.test";
        const code = await startAndReadCode(address);
        await request(apps.publicApp)
          .post("/api/auth/register/complete")
          .set("Idempotency-Key", uuid())
          .send(completeBody({ email: address, code }));
        return request(apps.publicApp)
          .post("/api/auth/register/complete")
          .set("Idempotency-Key", uuid())
          .send(completeBody({ email: address, code, fullName: "Second Attempt" }));
      },
      // no challenge at all
      async () =>
        request(apps.publicApp)
          .post("/api/auth/register/complete")
          .set("Idempotency-Key", uuid())
          .send(completeBody({ email: "never.started@example.test", code: "123456" })),
    ];

    const responses = [];
    for (const run of bodies) {
      responses.push(await run());
    }

    for (const response of responses) {
      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, "ValidationFailed");
      expect((response.body as { error: { details: unknown[] } }).error.details).toEqual([
        { field: "code", issue: "is invalid or expired" },
      ]);
    }
  });

  it("should return 400 field Idempotency-Key when the header is missing", async () => {
    const address = "nokey.patient@example.test";
    const code = await startAndReadCode(address);

    const response = await request(apps.publicApp)
      .post("/api/auth/register/complete")
      .send(completeBody({ email: address, code }));

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, "ValidationFailed");
    expect((response.body as { error: { details: unknown[] } }).error.details).toEqual([
      { field: "Idempotency-Key", issue: "is required" },
    ]);
    expect(await db("users").count({ count: "*" }).first()).toMatchObject({ count: "0" });
  });

  it("should replay the original 201 and create one user only when the same key and body are resent", async () => {
    const address = "replay.patient@example.test";
    const code = await startAndReadCode(address);
    const key = uuid();
    const body = completeBody({ email: address, code });

    const first = await request(apps.publicApp)
      .post("/api/auth/register/complete")
      .set("Idempotency-Key", key)
      .send(body);
    const replay = await request(apps.publicApp)
      .post("/api/auth/register/complete")
      .set("Idempotency-Key", key)
      .send(body);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(await db("users").count({ count: "*" }).first()).toMatchObject({ count: "1" });
  });

  it("should return 422 IdempotencyConflict when the same key carries a different body", async () => {
    const address = "conflict.patient@example.test";
    const code = await startAndReadCode(address);
    const key = uuid();

    await request(apps.publicApp)
      .post("/api/auth/register/complete")
      .set("Idempotency-Key", key)
      .send(completeBody({ email: address, code }));
    const conflicting = await request(apps.publicApp)
      .post("/api/auth/register/complete")
      .set("Idempotency-Key", key)
      .send(completeBody({ email: address, code, fullName: "Someone Else" }));

    expect(conflicting.status).toBe(422);
    expectErrorEnvelope(conflicting.body, "IdempotencyConflict");
  });

  it("should return 409 Conflict when the email was registered after the challenge was proven", async () => {
    const address = "race.patient@example.test";
    const code = await startAndReadCode(address);
    await seedUser({ email: address });

    const response = await request(apps.publicApp)
      .post("/api/auth/register/complete")
      .set("Idempotency-Key", uuid())
      .send(completeBody({ email: address, code }));

    expect(response.status).toBe(409);
    expectErrorEnvelope(response.body, "Conflict");
    const challenges = await challengesFor(address);
    expect(challenges[0]?.consumed_at).toBeNull();
  });

  it("should never carry a hash, a code or a token in any registration response", async () => {
    const address = "secrets.patient@example.test";
    const code = await startAndReadCode(address);

    const created = await request(apps.publicApp)
      .post("/api/auth/register/complete")
      .set("Idempotency-Key", uuid())
      .send(completeBody({ email: address, code }));
    const serialized = JSON.stringify(created.body);

    expect(serialized).not.toContain("$argon2");
    expect(serialized).not.toContain("passwordHash");
    expect(serialized).not.toContain("codeHash");
    expect(serialized).not.toContain(code);
    expect(serialized).not.toContain(TEST_PASSWORD);
  });
});

describe("outbox rows written by registration", () => {
  it("should hold ids only, with no address, name or code in any column", async () => {
    const address = "outbox.patient@example.test";
    await request(apps.publicApp).post("/api/auth/register/start").send({ email: address });
    await seedUser({ email: "existing.patient@example.test" });
    await request(apps.publicApp)
      .post("/api/auth/register/start")
      .send({ email: "existing.patient@example.test" });

    const rows = await outboxRows();
    const serialized = JSON.stringify(rows);

    expect(rows).toHaveLength(2);
    expect(serialized).not.toContain(address);
    expect(serialized).not.toContain("example.test");
    expect(serialized).not.toContain("Amira");
    expect(serialized).not.toMatch(/\b[0-9]{6}\b/);
    for (const row of rows) {
      expect(row.last_error).toBeNull();
      expect(row.request_id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
