import type { Knex } from "knex";
import { PasswordReset } from "../../../../src/app/auth/entity/password-reset.entity";
import { User } from "../../../../src/app/auth/entity/user.entity";
import { RevokedReason } from "../../../../src/app/auth/enums";
import { PasswordService } from "../../../../src/app/auth/service/password.service";
import type { SessionService } from "../../../../src/app/auth/service/session.service";
import type { Env } from "../../../../src/lib/config/types";
import { AppError } from "../../../../src/lib/error/AppError";
import { Logger } from "../../../../src/lib/logger/logger";
import type { PasswordHasher } from "../../../../src/lib/password/password-hasher";
import type { Clock } from "../../../../src/lib/time/types";
import { hmacSha256Hex } from "../../../../src/pkg/utils/crypto";
import type { MockedModule } from "../../../helpers/types";

jest.mock("../../../../src/app/auth/repository/password-reset.repo", () => ({
  invalidateOpenForUser: jest.fn(),
  insertReset: jest.fn(),
  findLatestOpenForUpdate: jest.fn(),
  recordFailedAttempt: jest.fn(),
  markUsed: jest.fn(),
}));
jest.mock("../../../../src/app/auth/repository/user.repo", () => ({
  findLiveByEmail: jest.fn(),
  findLiveById: jest.fn(),
  updatePasswordHash: jest.fn(),
}));
jest.mock("../../../../src/lib/outbox/outbox.repo", () => ({ enqueue: jest.fn() }));

const resets = jest.requireMock(
  "../../../../src/app/auth/repository/password-reset.repo",
) as MockedModule<typeof import("../../../../src/app/auth/repository/password-reset.repo")>;
const users = jest.requireMock("../../../../src/app/auth/repository/user.repo") as MockedModule<
  typeof import("../../../../src/app/auth/repository/user.repo")
>;
const outbox = jest.requireMock("../../../../src/lib/outbox/outbox.repo") as MockedModule<
  typeof import("../../../../src/lib/outbox/outbox.repo")
>;

const PEPPER = "synthetic-otp-pepper-value-0123456789abcdef";
const NOW = new Date("2026-09-18T10:00:00.000Z");
const EMAIL = "amira.patient@example.test";
const CODE = "123456";
const NEW_PASSWORD = "Synthetic-New-Passw0rd";
const NEW_HASH = "$argon2id$v=19$m=19456,t=2,p=1$bmV3c2FsdA$bmV3aGFzaA";
const REQUEST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const FAMILY = "8f1c4e2a-0000-4000-8000-000000000001";

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

function user(overrides: Partial<User> = {}): User {
  return new User({
    id: 1042,
    email: EMAIL,
    phone: null,
    passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA",
    fullName: "Amira Hassan",
    avatarUrl: null,
    role: "patient",
    status: "active",
    emailVerifiedAt: NOW,
    timezone: "Africa/Cairo",
    locale: "ar-EG",
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  });
}

function reset(overrides: Partial<PasswordReset> = {}): PasswordReset {
  return new PasswordReset({
    id: 31,
    userId: 1042,
    codeHash: hmacSha256Hex(PEPPER, CODE),
    attempts: 0,
    expiresAt: new Date(NOW.getTime() + 60_000),
    usedAt: null,
    invalidatedAt: null,
    createdAt: NOW,
    ...overrides,
  });
}

let sink: ReturnType<typeof logSink>;
let trx: { commit: jest.Mock; rollback: jest.Mock };
let db: Knex;
let hasher: PasswordHasher;
let sessions: SessionService;
let service: PasswordService;

beforeEach(() => {
  sink = logSink();
  trx = { commit: jest.fn().mockResolvedValue(undefined), rollback: jest.fn().mockResolvedValue(undefined) };
  db = { transaction: jest.fn().mockResolvedValue(trx) } as unknown as Knex;
  hasher = {
    hash: jest.fn().mockResolvedValue(NEW_HASH),
    verify: jest.fn().mockResolvedValue({ ok: true, needsRehash: false }),
    verifyDummy: jest.fn(),
  } as unknown as PasswordHasher;
  sessions = {
    revokeAllForUser: jest.fn().mockResolvedValue(3),
    revokeAllExceptFamily: jest.fn().mockResolvedValue(2),
    familyOfOwnToken: jest.fn().mockResolvedValue(undefined),
  } as unknown as SessionService;
  service = new PasswordService(db, sink.logger, clock, env, hasher, sessions);

  resets.insertReset.mockResolvedValue(31);
  resets.invalidateOpenForUser.mockResolvedValue(1);
  resets.recordFailedAttempt.mockResolvedValue(1);
  resets.markUsed.mockResolvedValue(1);
  users.updatePasswordHash.mockResolvedValue(1);
});

describe("PasswordService.forgot", () => {
  it("should invalidate open rows and enqueue a reset job when the email belongs to a live account", async () => {
    users.findLiveByEmail.mockResolvedValue(user());

    await service.forgot(EMAIL, REQUEST_ID);

    expect(resets.invalidateOpenForUser).toHaveBeenCalledWith(1042, trx);
    expect(resets.insertReset).toHaveBeenCalledWith(1042, trx);
    expect(outbox.enqueue).toHaveBeenCalledWith(trx, "send_password_reset", 31, REQUEST_ID);
    expect(trx.commit).toHaveBeenCalledTimes(1);
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "password_reset_requested", userId: 1042 }),
    );
    expect(sink.text()).not.toContain(EMAIL);
  });

  it("should write nothing when the email matches no live account", async () => {
    users.findLiveByEmail.mockResolvedValue(undefined);

    await expect(service.forgot(EMAIL, REQUEST_ID)).resolves.toBeUndefined();

    expect(db.transaction).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it("should send a code to a suspended account when it asks for a reset", async () => {
    users.findLiveByEmail.mockResolvedValue(user({ status: "suspended" }));

    await service.forgot(EMAIL, REQUEST_ID);

    expect(outbox.enqueue).toHaveBeenCalledWith(trx, "send_password_reset", 31, REQUEST_ID);
  });

  it("should roll back and rethrow when the transaction fails", async () => {
    users.findLiveByEmail.mockResolvedValue(user());
    resets.insertReset.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(service.forgot(EMAIL, REQUEST_ID)).rejects.toThrow("ECONNREFUSED");
    expect(trx.rollback).toHaveBeenCalledTimes(1);
  });
});

describe("PasswordService.reset", () => {
  const input = { email: EMAIL, code: CODE, newPassword: NEW_PASSWORD };

  it("should apply the new hash, use the row and revoke every family when the code matches", async () => {
    users.findLiveByEmail.mockResolvedValue(user());
    resets.findLatestOpenForUpdate.mockResolvedValue(reset());

    await service.reset(input);

    expect(users.updatePasswordHash).toHaveBeenCalledWith(1042, NEW_HASH, trx);
    expect(resets.markUsed).toHaveBeenCalledWith(31, trx);
    expect(resets.invalidateOpenForUser).toHaveBeenCalledWith(1042, trx);
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(trx, 1042, RevokedReason.PasswordReset);
    expect(trx.commit).toHaveBeenCalledTimes(1);
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "password_reset_completed", userId: 1042, revokedSessions: 3 }),
    );
  });

  it("should hash the new password before the transaction on every outcome, unknown email included", async () => {
    const order: string[] = [];
    (hasher.hash as jest.Mock).mockImplementation(async () => {
      order.push("hash");
      return NEW_HASH;
    });
    (db.transaction as jest.Mock).mockImplementation(async () => {
      order.push("transaction");
      return trx;
    });
    users.findLiveByEmail.mockResolvedValue(undefined);

    await expect(service.reset(input)).rejects.toMatchObject({ code: "ValidationFailed" });

    expect(order).toEqual(["hash", "transaction"]);
    expect(hasher.hash).toHaveBeenCalledWith(NEW_PASSWORD);
  });

  it("should answer the identical 400 field code for every failure reason", async () => {
    const cases: [User | undefined, PasswordReset | undefined][] = [
      [undefined, undefined],
      [user(), undefined],
      [user(), reset({ codeHash: null, expiresAt: null })],
      [user(), reset({ expiresAt: new Date(NOW.getTime() - 1000) })],
      [user(), reset({ codeHash: hmacSha256Hex(PEPPER, "999999") })],
    ];

    for (const [foundUser, foundReset] of cases) {
      users.findLiveByEmail.mockResolvedValue(foundUser);
      resets.findLatestOpenForUpdate.mockResolvedValue(foundReset);

      try {
        await service.reset(input);
        throw new Error("expected a rejection");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect(err).toMatchObject({ code: "ValidationFailed", status: 400 });
        expect((err as AppError).details).toEqual([{ field: "code", issue: "is invalid or expired" }]);
      }
    }
  });

  it("should not look for a reset row when the email matches no live account", async () => {
    users.findLiveByEmail.mockResolvedValue(undefined);

    await expect(service.reset(input)).rejects.toMatchObject({ code: "ValidationFailed" });

    expect(resets.findLatestOpenForUpdate).not.toHaveBeenCalled();
    expect(resets.recordFailedAttempt).not.toHaveBeenCalled();
    expect(trx.commit).toHaveBeenCalledTimes(1);
  });

  it("should count the attempt and commit when the code is wrong", async () => {
    users.findLiveByEmail.mockResolvedValue(user());
    resets.findLatestOpenForUpdate.mockResolvedValue(
      reset({ attempts: 1, codeHash: hmacSha256Hex(PEPPER, "999999") }),
    );

    await expect(service.reset(input)).rejects.toMatchObject({ code: "ValidationFailed" });

    expect(resets.recordFailedAttempt).toHaveBeenCalledWith(31, false, trx);
    expect(trx.commit).toHaveBeenCalledTimes(1);
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "password_reset_failed", outcome: "mismatch", attempts: 2 }),
    );
  });

  it("should invalidate the row on the fifth failed attempt", async () => {
    users.findLiveByEmail.mockResolvedValue(user());
    resets.findLatestOpenForUpdate.mockResolvedValue(
      reset({ attempts: 4, codeHash: hmacSha256Hex(PEPPER, "999999") }),
    );

    await expect(service.reset(input)).rejects.toMatchObject({ code: "ValidationFailed" });

    expect(resets.recordFailedAttempt).toHaveBeenCalledWith(31, true, trx);
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "password_reset_failed", outcome: "exhausted", attempts: 5 }),
    );
  });

  it("should treat a soft delete between the read and the update as an unknown email", async () => {
    users.findLiveByEmail.mockResolvedValue(user());
    resets.findLatestOpenForUpdate.mockResolvedValue(reset());
    users.updatePasswordHash.mockResolvedValue(0);

    await expect(service.reset(input)).rejects.toMatchObject({ code: "ValidationFailed" });

    expect(resets.markUsed).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "password_reset_failed", outcome: "no_reset" }),
    );
  });

  it("should roll back rather than silently accept a reset when the row could not be marked used", async () => {
    users.findLiveByEmail.mockResolvedValue(user());
    resets.findLatestOpenForUpdate.mockResolvedValue(reset());
    resets.markUsed.mockResolvedValue(0);

    await expect(service.reset(input)).rejects.toThrow("password_reset_use_conflict");
    expect(trx.rollback).toHaveBeenCalledTimes(1);
    expect(trx.commit).not.toHaveBeenCalled();
  });

  it("should never log the code, the new password or the email when a reset fails", async () => {
    users.findLiveByEmail.mockResolvedValue(user());
    resets.findLatestOpenForUpdate.mockResolvedValue(
      reset({ codeHash: hmacSha256Hex(PEPPER, "999999") }),
    );

    await expect(service.reset(input)).rejects.toMatchObject({ code: "ValidationFailed" });

    expect(sink.text()).not.toContain(CODE);
    expect(sink.text()).not.toContain(NEW_PASSWORD);
    expect(sink.text()).not.toContain(EMAIL);
    expect(sink.text()).not.toContain(PEPPER);
  });
});

describe("PasswordService.change", () => {
  const input = {
    userId: 1042,
    currentPassword: "Synthetic-Passw0rd",
    newPassword: NEW_PASSWORD,
    presentedRefreshToken: "kq3V0bXhZr9m1p2Yc8wS4tL7nA6eD5fG0hJ2iK3lM9o",
  };

  it("should keep the caller's own family and revoke the others when the current password is right", async () => {
    users.findLiveById.mockResolvedValue(user());
    (sessions.familyOfOwnToken as jest.Mock).mockResolvedValue(FAMILY);

    await service.change(input);

    expect(sessions.familyOfOwnToken).toHaveBeenCalledWith(input.presentedRefreshToken, 1042);
    expect(users.updatePasswordHash).toHaveBeenCalledWith(1042, NEW_HASH, trx);
    expect(sessions.revokeAllExceptFamily).toHaveBeenCalledWith(
      trx,
      1042,
      FAMILY,
      RevokedReason.PasswordChanged,
    );
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({
        message: "password_changed",
        userId: 1042,
        revokedSessions: 2,
        keptCurrentSession: true,
      }),
    );
  });

  it("should revoke every family when no cookie is sent or the cookie belongs to another user", async () => {
    users.findLiveById.mockResolvedValue(user());
    (sessions.familyOfOwnToken as jest.Mock).mockResolvedValue(undefined);

    await service.change({ ...input, presentedRefreshToken: undefined });

    expect(sessions.revokeAllExceptFamily).toHaveBeenCalledWith(
      trx,
      1042,
      undefined,
      RevokedReason.PasswordChanged,
    );
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "password_changed", keptCurrentSession: false }),
    );
  });

  it("should throw InvalidCredentials when the current password is wrong", async () => {
    users.findLiveById.mockResolvedValue(user());
    (hasher.verify as jest.Mock).mockResolvedValue({ ok: false, needsRehash: false });

    await expect(service.change(input)).rejects.toMatchObject({
      code: "InvalidCredentials",
      status: 401,
    });
    expect(users.updatePasswordHash).not.toHaveBeenCalled();
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "password_change_failed", userId: 1042 }),
    );
  });

  it("should throw AccountSuspended before verifying anything when the row is suspended", async () => {
    users.findLiveById.mockResolvedValue(user({ status: "suspended" }));

    await expect(service.change(input)).rejects.toMatchObject({
      code: "AccountSuspended",
      status: 403,
    });
    expect(hasher.verify).not.toHaveBeenCalled();
  });

  it("should throw Unauthorized when the subject no longer has a live row", async () => {
    users.findLiveById.mockResolvedValue(undefined);

    await expect(service.change(input)).rejects.toMatchObject({ code: "Unauthorized", status: 401 });
  });

  it("should throw Unauthorized and roll back when the update affects no row", async () => {
    users.findLiveById.mockResolvedValue(user());
    users.updatePasswordHash.mockResolvedValue(0);

    await expect(service.change(input)).rejects.toMatchObject({ code: "Unauthorized" });
    expect(trx.rollback).toHaveBeenCalled();
    expect(trx.commit).not.toHaveBeenCalled();
  });

  it("should never log either password when the change succeeds", async () => {
    users.findLiveById.mockResolvedValue(user());

    await service.change(input);

    expect(sink.text()).not.toContain(NEW_PASSWORD);
    expect(sink.text()).not.toContain(input.currentPassword);
    expect(sink.text()).not.toContain(input.presentedRefreshToken);
  });
});
