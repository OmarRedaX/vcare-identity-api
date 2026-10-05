import type { Knex } from "knex";
import { RegistrationChallenge } from "../../../../src/app/auth/entity/registration-challenge.entity";
import { User } from "../../../../src/app/auth/entity/user.entity";
import { RegistrationService } from "../../../../src/app/auth/service/registration.service";
import type { RegisterCompleteInput } from "../../../../src/app/auth/types";
import { AppError } from "../../../../src/lib/error/AppError";
import { Logger } from "../../../../src/lib/logger/logger";
import type { Env } from "../../../../src/lib/config/types";
import type { PasswordHasher } from "../../../../src/lib/password/password-hasher";
import type { Clock } from "../../../../src/lib/time/types";
import { hmacSha256Hex } from "../../../../src/pkg/utils/crypto";
import type { MockedModule } from "../../../helpers/types";

jest.mock("../../../../src/app/auth/repository/registration-challenge.repo", () => ({
  findLatestOpenForUpdate: jest.fn(),
  invalidateOpenForEmail: jest.fn(),
  lockEmailForStart: jest.fn(),
  insertChallenge: jest.fn(),
  recordFailedAttempt: jest.fn(),
  markConsumed: jest.fn(),
}));
jest.mock("../../../../src/app/auth/repository/user.repo", () => ({
  findLiveByEmail: jest.fn(),
  insertUser: jest.fn(),
}));
jest.mock("../../../../src/lib/outbox/outbox.repo", () => ({ enqueue: jest.fn() }));

const challenges = jest.requireMock<MockedModule<typeof import("../../../../src/app/auth/repository/registration-challenge.repo")>>("../../../../src/app/auth/repository/registration-challenge.repo");
const users = jest.requireMock<MockedModule<
  typeof import("../../../../src/app/auth/repository/user.repo")
>>("../../../../src/app/auth/repository/user.repo");
const outbox = jest.requireMock<MockedModule<
  typeof import("../../../../src/lib/outbox/outbox.repo")
>>("../../../../src/lib/outbox/outbox.repo");

const PEPPER = "synthetic-otp-pepper-value-0123456789abcdef";
const NOW = new Date("2026-09-18T10:00:00.000Z");
const REQUEST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const CODE = "123456";
const EMAIL = "amira.patient@example.test";
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA";

const clock: Clock = { now: () => NOW };
const env = { OTP_PEPPER: PEPPER } as Env;

function logSink(): { logger: Logger; lines: () => Record<string, unknown>[]; text: () => string } {
  const written: string[] = [];
  return {
    logger: new Logger({
      service: "identity-service",
      level: "debug",
      production: false,
      sink: (line) => {
        written.push(line);
      },
    }),
    lines: () =>
      written
        .join("")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    text: () => written.join(""),
  };
}

interface FakeDb {
  db: Knex;
  trx: { commit: jest.Mock; rollback: jest.Mock };
}

function fakeDb(): FakeDb {
  const trx = { commit: jest.fn().mockResolvedValue(undefined), rollback: jest.fn().mockResolvedValue(undefined) };
  const db = { transaction: jest.fn().mockResolvedValue(trx) } as unknown as Knex;
  return { db, trx };
}

function hasherStub(): PasswordHasher {
  return {
    hash: jest.fn().mockResolvedValue(PASSWORD_HASH),
    verify: jest.fn(),
    verifyDummy: jest.fn(),
  } as unknown as PasswordHasher;
}

function challenge(overrides: Partial<RegistrationChallenge> = {}): RegistrationChallenge {
  return new RegistrationChallenge({
    id: 9,
    email: EMAIL,
    codeHash: hmacSha256Hex(PEPPER, CODE),
    attempts: 0,
    expiresAt: new Date(NOW.getTime() + 60_000),
    consumedAt: null,
    invalidatedAt: null,
    createdAt: NOW,
    ...overrides,
  });
}

function createdUser(role: "patient" | "doctor" = "patient"): User {
  return new User({
    id: 1042,
    email: EMAIL,
    phone: null,
    passwordHash: PASSWORD_HASH,
    fullName: "Amira Hassan",
    avatarUrl: null,
    role,
    status: role === "doctor" ? "pending" : "active",
    emailVerifiedAt: NOW,
    timezone: "Africa/Cairo",
    locale: "ar-EG",
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  });
}

function input(overrides: Partial<RegisterCompleteInput> = {}): RegisterCompleteInput {
  return {
    email: EMAIL,
    code: CODE,
    password: "Synthetic-Passw0rd",
    fullName: "Amira Hassan",
    role: "patient",
    phone: undefined,
    timezone: "Africa/Cairo",
    locale: "ar-EG",
    ...overrides,
  };
}

let sink: ReturnType<typeof logSink>;
let db: FakeDb;
let hasher: PasswordHasher;
let service: RegistrationService;

beforeEach(() => {
  sink = logSink();
  db = fakeDb();
  hasher = hasherStub();
  service = new RegistrationService(db.db, sink.logger, clock, env, hasher);
  challenges.insertChallenge.mockResolvedValue(9);
  challenges.recordFailedAttempt.mockResolvedValue(1);
  challenges.markConsumed.mockResolvedValue(1);
  users.insertUser.mockResolvedValue(createdUser());
});

describe("RegistrationService.start", () => {
  it("should invalidate open challenges and enqueue a code job when the email is unknown", async () => {
    users.findLiveByEmail.mockResolvedValue(undefined);

    await service.start(EMAIL, REQUEST_ID);

    expect(challenges.lockEmailForStart).toHaveBeenCalledWith(EMAIL, db.trx);
    expect(challenges.invalidateOpenForEmail).toHaveBeenCalledWith(EMAIL, db.trx);
    expect(challenges.insertChallenge).toHaveBeenCalledWith(EMAIL, db.trx);
    expect(outbox.enqueue).toHaveBeenCalledWith(db.trx, "send_registration_code", 9, REQUEST_ID);
    expect(db.trx.commit).toHaveBeenCalledTimes(1);
  });

  it("should enqueue only an account-exists notice when the email belongs to a live account", async () => {
    users.findLiveByEmail.mockResolvedValue(createdUser());

    await service.start(EMAIL, REQUEST_ID);

    expect(challenges.insertChallenge).not.toHaveBeenCalled();
    expect(outbox.enqueue).toHaveBeenCalledWith(db.trx, "send_account_exists_notice", 1042, REQUEST_ID);
  });

  it("should log the same event with neither the email nor the outcome in either case", async () => {
    users.findLiveByEmail.mockResolvedValue(undefined);
    await service.start(EMAIL, REQUEST_ID);
    const unknownEmailLines = sink.lines().map((line) => line.message);

    users.findLiveByEmail.mockResolvedValue(createdUser());
    await service.start(EMAIL, REQUEST_ID);

    expect(unknownEmailLines).toEqual(["registration_start_accepted"]);
    expect(sink.lines().map((line) => line.message)).toEqual([
      "registration_start_accepted",
      "registration_start_accepted",
    ]);
    expect(sink.text()).not.toContain(EMAIL);
  });

  it("should roll back and rethrow when the transaction fails", async () => {
    users.findLiveByEmail.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(service.start(EMAIL, REQUEST_ID)).rejects.toThrow("connect ECONNREFUSED");
    expect(db.trx.rollback).toHaveBeenCalledTimes(1);
    expect(db.trx.commit).not.toHaveBeenCalled();
  });
});

describe("RegistrationService.complete", () => {
  it("should hash the password before opening the transaction when a registration is completed", async () => {
    challenges.findLatestOpenForUpdate.mockResolvedValue(challenge());
    const order: string[] = [];
    (hasher.hash as jest.Mock).mockImplementation(() => {
      order.push("hash");
      return Promise.resolve(PASSWORD_HASH);
    });
    (db.db.transaction as jest.Mock).mockImplementation(() => {
      order.push("transaction");
      return Promise.resolve(db.trx);
    });

    await service.complete(input());

    expect(order).toEqual(["hash", "transaction"]);
  });

  it("should consume the challenge and create an active patient when the code matches", async () => {
    challenges.findLatestOpenForUpdate.mockResolvedValue(challenge());

    const user = await service.complete(input());

    expect(challenges.markConsumed).toHaveBeenCalledWith(9, db.trx);
    expect(users.insertUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: EMAIL, status: "active", role: "patient", passwordHash: PASSWORD_HASH }),
      db.trx,
    );
    expect(user.status).toBe("active");
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "user_registered", userId: 1042 }),
    );
  });

  it("should create a pending account when the role is doctor", async () => {
    challenges.findLatestOpenForUpdate.mockResolvedValue(challenge());
    users.insertUser.mockResolvedValue(createdUser("doctor"));

    await service.complete(input({ role: "doctor" }));

    expect(users.insertUser).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending", role: "doctor" }),
      db.trx,
    );
  });

  it("should store a null phone when none is submitted", async () => {
    challenges.findLatestOpenForUpdate.mockResolvedValue(challenge());

    await service.complete(input());

    expect(users.insertUser).toHaveBeenCalledWith(expect.objectContaining({ phone: null }), db.trx);
  });

  it("should throw the same ValidationFailed field code for every unusable challenge", async () => {
    const cases: [string, RegistrationChallenge | undefined][] = [
      ["no challenge", undefined],
      ["never sent", challenge({ codeHash: null, expiresAt: null })],
      ["expired", challenge({ expiresAt: new Date(NOW.getTime() - 1000) })],
      ["wrong code", challenge({ codeHash: hmacSha256Hex(PEPPER, "999999") })],
    ];

    for (const [, row] of cases) {
      challenges.findLatestOpenForUpdate.mockResolvedValue(row);
      try {
        await service.complete(input());
        throw new Error("expected a rejection");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect(err).toMatchObject({ code: "ValidationFailed", status: 400 });
        expect((err as AppError).details).toEqual([{ field: "code", issue: "is invalid or expired" }]);
      }
    }
  });

  it("should count the attempt and commit when the code is wrong", async () => {
    challenges.findLatestOpenForUpdate.mockResolvedValue(
      challenge({ attempts: 2, codeHash: hmacSha256Hex(PEPPER, "999999") }),
    );

    await expect(service.complete(input())).rejects.toMatchObject({ code: "ValidationFailed" });

    expect(challenges.recordFailedAttempt).toHaveBeenCalledWith(9, false, db.trx);
    expect(db.trx.commit).toHaveBeenCalledTimes(1);
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "registration_code_failed", attempts: 3, exhausted: false }),
    );
  });

  it("should invalidate the challenge on the fifth failed attempt", async () => {
    challenges.findLatestOpenForUpdate.mockResolvedValue(
      challenge({ attempts: 4, codeHash: hmacSha256Hex(PEPPER, "999999") }),
    );

    await expect(service.complete(input())).rejects.toMatchObject({ code: "ValidationFailed" });

    expect(challenges.recordFailedAttempt).toHaveBeenCalledWith(9, true, db.trx);
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "registration_code_failed", attempts: 5, exhausted: true }),
    );
  });

  it("should not count an attempt when there is no candidate challenge", async () => {
    challenges.findLatestOpenForUpdate.mockResolvedValue(undefined);

    await expect(service.complete(input())).rejects.toMatchObject({ code: "ValidationFailed" });

    expect(challenges.recordFailedAttempt).not.toHaveBeenCalled();
    expect(users.insertUser).not.toHaveBeenCalled();
  });

  it("should map a unique violation to 409 Conflict and leave the challenge unconsumed", async () => {
    challenges.findLatestOpenForUpdate.mockResolvedValue(challenge());
    const violation = Object.assign(new Error("duplicate key"), { code: "23505" });
    users.insertUser.mockRejectedValue(violation);

    await expect(service.complete(input())).rejects.toMatchObject({
      code: "Conflict",
      status: 409,
    });
    expect(db.trx.rollback).toHaveBeenCalledTimes(1);
    expect(db.trx.commit).not.toHaveBeenCalled();
  });

  it("should propagate an infrastructure failure when the database is unreachable", async () => {
    challenges.findLatestOpenForUpdate.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5432"));

    await expect(service.complete(input())).rejects.toThrow("ECONNREFUSED");
    expect(db.trx.rollback).toHaveBeenCalledTimes(1);
  });

  it("should never log the code, the password or the email when a registration fails", async () => {
    challenges.findLatestOpenForUpdate.mockResolvedValue(
      challenge({ codeHash: hmacSha256Hex(PEPPER, "999999") }),
    );

    await expect(service.complete(input())).rejects.toMatchObject({ code: "ValidationFailed" });

    expect(sink.text()).not.toContain(CODE);
    expect(sink.text()).not.toContain(EMAIL);
    expect(sink.text()).not.toContain("Synthetic-Passw0rd");
    expect(sink.text()).not.toContain(PEPPER);
  });
});
