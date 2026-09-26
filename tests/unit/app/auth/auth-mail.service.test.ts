import type { Knex } from "knex";
import { PasswordReset } from "../../../../src/app/auth/entity/password-reset.entity";
import { RegistrationChallenge } from "../../../../src/app/auth/entity/registration-challenge.entity";
import { User } from "../../../../src/app/auth/entity/user.entity";
import { AuthMailService } from "../../../../src/app/auth/service/auth-mail.service";
import type { Env } from "../../../../src/lib/config/types";
import { MemoryCaptureEmailAdapter } from "../../../../src/lib/email/memory-capture-adapter";
import type { OutboxJob } from "../../../../src/lib/outbox/types";
import { hmacSha256Hex } from "../../../../src/pkg/utils/crypto";
import type { MockedModule } from "../../../helpers/types";

jest.mock("../../../../src/app/auth/repository/registration-challenge.repo", () => ({
  findByIdForUpdate: jest.fn(),
  markSent: jest.fn(),
}));
jest.mock("../../../../src/app/auth/repository/password-reset.repo", () => ({
  findByIdForUpdate: jest.fn(),
  markSent: jest.fn(),
}));
jest.mock("../../../../src/app/auth/repository/user.repo", () => ({ findLiveById: jest.fn() }));

const challenges = jest.requireMock(
  "../../../../src/app/auth/repository/registration-challenge.repo",
) as MockedModule<typeof import("../../../../src/app/auth/repository/registration-challenge.repo")>;
const resets = jest.requireMock(
  "../../../../src/app/auth/repository/password-reset.repo",
) as MockedModule<typeof import("../../../../src/app/auth/repository/password-reset.repo")>;
const users = jest.requireMock("../../../../src/app/auth/repository/user.repo") as MockedModule<
  typeof import("../../../../src/app/auth/repository/user.repo")
>;

const PEPPER = "synthetic-otp-pepper-value-0123456789abcdef";
const APP_BASE_URL = "https://app.example.test";
const EMAIL = "amira.patient@example.test";
const NOW = new Date("2026-09-18T10:00:00.000Z");

const env = { OTP_PEPPER: PEPPER, APP_BASE_URL } as Env;

function job(type: OutboxJob["type"], aggregateId = 9): OutboxJob {
  return {
    id: 1,
    type,
    aggregateId,
    attempts: 1,
    requestId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  };
}

function challenge(overrides: Partial<RegistrationChallenge> = {}): RegistrationChallenge {
  return new RegistrationChallenge({
    id: 9,
    email: EMAIL,
    codeHash: null,
    attempts: 0,
    expiresAt: null,
    consumedAt: null,
    invalidatedAt: null,
    createdAt: NOW,
    ...overrides,
  });
}

function reset(overrides: Partial<PasswordReset> = {}): PasswordReset {
  return new PasswordReset({
    id: 31,
    userId: 1042,
    codeHash: null,
    attempts: 0,
    expiresAt: null,
    usedAt: null,
    invalidatedAt: null,
    createdAt: NOW,
    ...overrides,
  });
}

function user(): User {
  return new User({
    id: 1042,
    email: EMAIL,
    phone: null,
    passwordHash: "$argon2id$hash",
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
  });
}

let trx: { commit: jest.Mock; rollback: jest.Mock };
let db: Knex;
let email: MemoryCaptureEmailAdapter;
let service: AuthMailService;
const signal = new AbortController().signal;

beforeEach(() => {
  trx = { commit: jest.fn().mockResolvedValue(undefined), rollback: jest.fn().mockResolvedValue(undefined) };
  db = { transaction: jest.fn().mockResolvedValue(trx) } as unknown as Knex;
  email = new MemoryCaptureEmailAdapter();
  service = new AuthMailService(db, env, email);
  challenges.markSent.mockResolvedValue(1);
  resets.markSent.mockResolvedValue(1);
});

function handlerFor(type: OutboxJob["type"]) {
  const handler = service.handlers().get(type);
  if (handler === undefined) {
    throw new Error(`no handler registered for ${type}`);
  }
  return handler;
}

function codeFrom(text: string): string {
  const match = /\b([0-9]{6})\b/.exec(text);
  if (!match?.[1]) {
    throw new Error("the email carries no six-digit code");
  }
  return match[1];
}

describe("AuthMailService handlers", () => {
  it("should register one handler per outbox job type", () => {
    expect([...service.handlers().keys()].sort()).toEqual([
      "send_account_exists_notice",
      "send_password_reset",
      "send_registration_code",
    ]);
  });
});

describe("send_registration_code", () => {
  it("should store only the HMAC of the generated code and email the plaintext once", async () => {
    challenges.findByIdForUpdate.mockResolvedValue(challenge());

    await expect(handlerFor("send_registration_code")(job("send_registration_code"), signal)).resolves.toBe(
      "sent",
    );

    const [message] = email.messages();
    const code = codeFrom(message?.text ?? "");
    expect(message?.to).toBe(EMAIL);
    expect(challenges.markSent).toHaveBeenCalledWith(9, hmacSha256Hex(PEPPER, code), trx);
    expect(trx.commit).toHaveBeenCalledTimes(1);
  });

  it("should commit the hash before sending so a crash re-sends a superseding code", async () => {
    challenges.findByIdForUpdate.mockResolvedValue(challenge());
    const order: string[] = [];
    trx.commit.mockImplementation(async () => {
      order.push("commit");
    });
    const failing = new AuthMailService(db, env, {
      send: async () => {
        order.push("send");
      },
    });

    await failing.handlers().get("send_registration_code")?.(job("send_registration_code"), signal);

    expect(order).toEqual(["commit", "send"]);
  });

  it("should skip without sending when the challenge is gone, consumed or invalidated", async () => {
    for (const row of [
      undefined,
      challenge({ consumedAt: NOW }),
      challenge({ invalidatedAt: NOW }),
    ]) {
      challenges.findByIdForUpdate.mockResolvedValue(row);

      await expect(
        handlerFor("send_registration_code")(job("send_registration_code"), signal),
      ).resolves.toBe("skipped");
    }

    expect(email.messages()).toHaveLength(0);
    expect(challenges.markSent).not.toHaveBeenCalled();
  });

  it("should roll back and rethrow when the row cannot be updated", async () => {
    challenges.findByIdForUpdate.mockResolvedValue(challenge());
    challenges.markSent.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(
      handlerFor("send_registration_code")(job("send_registration_code"), signal),
    ).rejects.toThrow("ECONNREFUSED");
    expect(trx.rollback).toHaveBeenCalledTimes(1);
    expect(email.messages()).toHaveLength(0);
  });
});

describe("send_account_exists_notice", () => {
  it("should email the notice with no code when the account exists", async () => {
    users.findLiveById.mockResolvedValue(user());

    await expect(
      handlerFor("send_account_exists_notice")(job("send_account_exists_notice", 1042), signal),
    ).resolves.toBe("sent");

    const [message] = email.messages();
    expect(message?.to).toBe(EMAIL);
    expect(message?.text).not.toMatch(/[0-9]{6}/);
    expect(message?.text).toContain(APP_BASE_URL);
  });

  it("should skip when the account is gone", async () => {
    users.findLiveById.mockResolvedValue(undefined);

    await expect(
      handlerFor("send_account_exists_notice")(job("send_account_exists_notice", 1042), signal),
    ).resolves.toBe("skipped");
    expect(email.messages()).toHaveLength(0);
  });
});

describe("send_password_reset", () => {
  it("should store only the HMAC of the generated code and email the plaintext once", async () => {
    resets.findByIdForUpdate.mockResolvedValue(reset());
    users.findLiveById.mockResolvedValue(user());

    await expect(handlerFor("send_password_reset")(job("send_password_reset", 31), signal)).resolves.toBe(
      "sent",
    );

    const [message] = email.messages();
    const code = codeFrom(message?.text ?? "");
    expect(message?.to).toBe(EMAIL);
    expect(resets.markSent).toHaveBeenCalledWith(31, hmacSha256Hex(PEPPER, code), trx);
    expect(message?.text).not.toContain(`${APP_BASE_URL}/reset-password?`);
  });

  it("should skip without sending when the reset row is gone, used or invalidated", async () => {
    users.findLiveById.mockResolvedValue(user());
    for (const row of [undefined, reset({ usedAt: NOW }), reset({ invalidatedAt: NOW })]) {
      resets.findByIdForUpdate.mockResolvedValue(row);

      await expect(
        handlerFor("send_password_reset")(job("send_password_reset", 31), signal),
      ).resolves.toBe("skipped");
    }

    expect(email.messages()).toHaveLength(0);
  });

  it("should skip when the owning account no longer exists", async () => {
    resets.findByIdForUpdate.mockResolvedValue(reset());
    users.findLiveById.mockResolvedValue(undefined);

    await expect(
      handlerFor("send_password_reset")(job("send_password_reset", 31), signal),
    ).resolves.toBe("skipped");
    expect(email.messages()).toHaveLength(0);
  });

  it("should draw a different code on every delivery attempt", async () => {
    resets.findByIdForUpdate.mockResolvedValue(reset());
    users.findLiveById.mockResolvedValue(user());

    const codes = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      email.clear();
      await handlerFor("send_password_reset")(job("send_password_reset", 31), signal);
      codes.add(codeFrom(email.messages()[0]?.text ?? ""));
    }

    expect(codes.size).toBeGreaterThan(1);
  });
});
