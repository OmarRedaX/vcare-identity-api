import type Redis from "ioredis";
import type { Knex } from "knex";
import { RefreshToken } from "../../../../src/app/auth/entity/refresh-token.entity";
import { User } from "../../../../src/app/auth/entity/user.entity";
import { RevokedReason } from "../../../../src/app/auth/enums";
import { SessionService } from "../../../../src/app/auth/service/session.service";
import type { TokenSigner } from "../../../../src/lib/auth/jwt";
import type { Env } from "../../../../src/lib/config/types";
import { Logger } from "../../../../src/lib/logger/logger";
import type { PasswordHasher } from "../../../../src/lib/password/password-hasher";
import type { Clock } from "../../../../src/lib/time/types";
import { sha256Hex } from "../../../../src/pkg/utils/crypto";
import type { MockedModule } from "../../../helpers/types";

jest.mock("../../../../src/app/auth/repository/refresh-token.repo", () => ({
  findByTokenHash: jest.fn(),
  findById: jest.fn(),
  findByIdForUpdate: jest.fn(),
  insertToken: jest.fn(),
  markRotated: jest.fn(),
  revokeFamily: jest.fn(),
  revokeAllForUser: jest.fn(),
  listLiveFamilies: jest.fn(),
}));
jest.mock("../../../../src/app/auth/repository/user.repo", () => ({
  findLiveByEmail: jest.fn(),
  findLiveById: jest.fn(),
  findLiveByIdForUpdate: jest.fn(),
  findLiveByIdForShare: jest.fn(),
  updatePasswordHash: jest.fn(),
}));
jest.mock("../../../../src/lib/rate-limit/rate-limit", () => ({
  consumeRateLimit: jest.fn(),
  logRateLimited: jest.fn(),
}));

const tokens = jest.requireMock<MockedModule<typeof import("../../../../src/app/auth/repository/refresh-token.repo")>>("../../../../src/app/auth/repository/refresh-token.repo");
const users = jest.requireMock<MockedModule<
  typeof import("../../../../src/app/auth/repository/user.repo")
>>("../../../../src/app/auth/repository/user.repo");
const limiter = jest.requireMock<MockedModule<
  typeof import("../../../../src/lib/rate-limit/rate-limit")
>>("../../../../src/lib/rate-limit/rate-limit");

const NOW = new Date("2026-09-18T10:00:00.000Z");
const EMAIL = "amira.patient@example.test";
const PASSWORD = "Synthetic-Passw0rd";
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA";
const FAMILY = "8f1c4e2a-0000-4000-8000-000000000001";
const ACCESS_TOKEN = "synthetic.access.token";
const PRESENTED = "kq3V0bXhZr9m1p2Yc8wS4tL7nA6eD5fG0hJ2iK3lM9o";

const clock: Clock = { now: () => NOW };
const env = { REFRESH_REUSE_GRACE_SECONDS: 10, RATE_LIMIT_FALLBACK_DIVISOR: 2 } as Env;
const redis = { status: "ready" } as unknown as Redis;

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
    passwordHash: PASSWORD_HASH,
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

function refreshRow(overrides: Partial<RefreshToken> = {}): RefreshToken {
  return new RefreshToken({
    id: 5,
    userId: 1042,
    familyId: FAMILY,
    tokenHash: sha256Hex(PRESENTED),
    expiresAt: new Date(NOW.getTime() + 86_400_000),
    revokedAt: null,
    revokedReason: null,
    replacedById: null,
    deviceInfo: "jest-agent",
    createdAt: NOW,
    ...overrides,
  });
}

let sink: ReturnType<typeof logSink>;
let trx: { commit: jest.Mock; rollback: jest.Mock };
let dbMock: { transaction: jest.Mock };
let hasherMock: { hash: jest.Mock; verify: jest.Mock; verifyDummy: jest.Mock };
let signerMock: { signUserToken: jest.Mock };
let service: SessionService;

beforeEach(() => {
  sink = logSink();
  trx = { commit: jest.fn().mockResolvedValue(undefined), rollback: jest.fn().mockResolvedValue(undefined) };
  dbMock = { transaction: jest.fn().mockResolvedValue(trx) };
  hasherMock = {
    hash: jest.fn().mockResolvedValue(PASSWORD_HASH),
    verify: jest.fn().mockResolvedValue({ ok: true, needsRehash: false }),
    verifyDummy: jest.fn().mockResolvedValue(undefined),
  };
  signerMock = { signUserToken: jest.fn().mockResolvedValue(ACCESS_TOKEN) };
  service = new SessionService(
    dbMock as unknown as Knex,
    redis,
    sink.logger,
    clock,
    env,
    hasherMock as unknown as PasswordHasher,
    signerMock as unknown as TokenSigner,
  );

  limiter.consumeRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  tokens.insertToken.mockResolvedValue(77);
  tokens.markRotated.mockResolvedValue(1);
  tokens.revokeFamily.mockResolvedValue(1);
  tokens.revokeAllForUser.mockResolvedValue(2);
  users.updatePasswordHash.mockResolvedValue(1);
  // The locked re-read sees the same account the first read returned unless a test says it changed.
  users.findLiveByIdForUpdate.mockImplementation(
    async () => ((await users.findLiveByEmail(EMAIL)) as User | undefined) ?? user(),
  );
});

describe("SessionService.login", () => {
  it("should store only the sha256 of a fresh token and return it once when the credentials are valid", async () => {
    users.findLiveByEmail.mockResolvedValue(user());

    const result = await service.login({ email: EMAIL, password: PASSWORD, userAgent: "jest-agent" });

    expect(result.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.accessToken).toBe(ACCESS_TOKEN);
    expect(tokens.insertToken).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 1042,
        tokenHash: sha256Hex(result.refreshToken),
        expiresAt: new Date(NOW.getTime() + 30 * 86_400_000),
        deviceInfo: "jest-agent",
      }),
      trx,
    );
    const inserted = (tokens.insertToken.mock.calls as unknown[][])[0]?.[0] as { familyId: string };
    expect(inserted.familyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(trx.commit).toHaveBeenCalledTimes(1);
  });

  it("should verify a dummy hash and answer InvalidCredentials when the email is unknown", async () => {
    users.findLiveByEmail.mockResolvedValue(undefined);

    await expect(
      service.login({ email: EMAIL, password: PASSWORD, userAgent: undefined }),
    ).rejects.toMatchObject({ code: "InvalidCredentials", status: 401 });

    expect(hasherMock.verifyDummy).toHaveBeenCalledWith(PASSWORD);
    expect(tokens.insertToken).not.toHaveBeenCalled();
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "login_failed", reason: "unknown_email" }),
    );
  });

  it("should answer InvalidCredentials without a dummy verify when the password is wrong", async () => {
    users.findLiveByEmail.mockResolvedValue(user());
    hasherMock.verify.mockResolvedValue({ ok: false, needsRehash: false });

    await expect(
      service.login({ email: EMAIL, password: PASSWORD, userAgent: undefined }),
    ).rejects.toMatchObject({ code: "InvalidCredentials" });

    expect(hasherMock.verifyDummy).not.toHaveBeenCalled();
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "login_failed", reason: "wrong_password", userId: 1042 }),
    );
  });

  it("should answer AccountSuspended only after the password verified when the account is suspended", async () => {
    users.findLiveByEmail.mockResolvedValue(user({ status: "suspended" }));

    await expect(
      service.login({ email: EMAIL, password: PASSWORD, userAgent: undefined }),
    ).rejects.toMatchObject({ code: "AccountSuspended", status: 403 });

    expect(hasherMock.verify).toHaveBeenCalled();
    expect(tokens.insertToken).not.toHaveBeenCalled();
  });

  it("should answer InvalidCredentials, not AccountSuspended, when a suspended account sends a wrong password", async () => {
    users.findLiveByEmail.mockResolvedValue(user({ status: "suspended" }));
    hasherMock.verify.mockResolvedValue({ ok: false, needsRehash: false });

    await expect(
      service.login({ email: EMAIL, password: PASSWORD, userAgent: undefined }),
    ).rejects.toMatchObject({ code: "InvalidCredentials" });
  });

  it("should answer InvalidCredentials and insert no session when the password hash changed after the verify", async () => {
    users.findLiveByEmail.mockResolvedValue(user());
    users.findLiveByIdForUpdate.mockResolvedValue(user({ passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$bmV3c2FsdA$bmV3" }));

    await expect(
      service.login({ email: EMAIL, password: PASSWORD, userAgent: undefined }),
    ).rejects.toMatchObject({ code: "InvalidCredentials", status: 401 });

    expect(tokens.insertToken).not.toHaveBeenCalled();
    expect(trx.rollback).toHaveBeenCalled();
    expect(trx.commit).not.toHaveBeenCalled();
  });

  it("should answer InvalidCredentials and insert no session when the account was soft-deleted after the verify", async () => {
    users.findLiveByEmail.mockResolvedValue(user());
    users.findLiveByIdForUpdate.mockResolvedValue(undefined);

    await expect(
      service.login({ email: EMAIL, password: PASSWORD, userAgent: undefined }),
    ).rejects.toMatchObject({ code: "InvalidCredentials" });

    expect(tokens.insertToken).not.toHaveBeenCalled();
  });

  it("should answer AccountSuspended and insert no session when the account was suspended after the verify", async () => {
    users.findLiveByEmail.mockResolvedValue(user());
    users.findLiveByIdForUpdate.mockResolvedValue(user({ status: "suspended" }));

    await expect(
      service.login({ email: EMAIL, password: PASSWORD, userAgent: undefined }),
    ).rejects.toMatchObject({ code: "AccountSuspended", status: 403 });

    expect(tokens.insertToken).not.toHaveBeenCalled();
    expect(trx.rollback).toHaveBeenCalled();
  });

  it("should log in a pending or rejected account when the credentials are valid", async () => {
    for (const status of ["pending", "rejected"] as const) {
      users.findLiveByEmail.mockResolvedValue(user({ status }));

      await expect(
        service.login({ email: EMAIL, password: PASSWORD, userAgent: undefined }),
      ).resolves.toMatchObject({ accessToken: ACCESS_TOKEN });
    }
  });

  it("should rehash a legacy hash inside the login transaction when a rehash is needed", async () => {
    users.findLiveByEmail.mockResolvedValue(user({ passwordHash: "$2b$10$legacy" }));
    hasherMock.verify.mockResolvedValue({ ok: true, needsRehash: true });

    await service.login({ email: EMAIL, password: PASSWORD, userAgent: undefined });

    expect(hasherMock.hash).toHaveBeenCalledWith(PASSWORD);
    expect(users.updatePasswordHash).toHaveBeenCalledWith(1042, PASSWORD_HASH, trx);
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "password_rehashed", userId: 1042 }),
    );
  });

  it("should still log in and skip the rehash when the hash queue is full", async () => {
    users.findLiveByEmail.mockResolvedValue(user({ passwordHash: "$2b$10$legacy" }));
    hasherMock.verify.mockResolvedValue({ ok: true, needsRehash: true });
    hasherMock.hash.mockRejectedValue(new Error("queue full"));

    await expect(
      service.login({ email: EMAIL, password: PASSWORD, userAgent: undefined }),
    ).resolves.toMatchObject({ accessToken: ACCESS_TOKEN });

    expect(users.updatePasswordHash).not.toHaveBeenCalled();
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "password_rehash_skipped", userId: 1042 }),
    );
  });

  it("should sanitise the device info when the User-Agent is absent, blank, or oversized", async () => {
    users.findLiveByEmail.mockResolvedValue(user());

    await service.login({ email: EMAIL, password: PASSWORD, userAgent: undefined });
    expect((tokens.insertToken.mock.calls as unknown[][])[0]?.[0]).toMatchObject({ deviceInfo: null });

    await service.login({ email: EMAIL, password: PASSWORD, userAgent: "" });
    expect((tokens.insertToken.mock.calls as unknown[][])[1]?.[0]).toMatchObject({ deviceInfo: null });

    await service.login({ email: EMAIL, password: PASSWORD, userAgent: "u".repeat(400) });
    const third = (tokens.insertToken.mock.calls as unknown[][])[2]?.[0] as { deviceInfo: string };
    expect(third.deviceInfo).toHaveLength(255);
  });

  it("should roll back and rethrow when the session insert fails", async () => {
    users.findLiveByEmail.mockResolvedValue(user());
    tokens.insertToken.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(
      service.login({ email: EMAIL, password: PASSWORD, userAgent: undefined }),
    ).rejects.toThrow("ECONNREFUSED");
    expect(trx.rollback).toHaveBeenCalledTimes(1);
    expect(trx.commit).not.toHaveBeenCalled();
  });

  it("should never log the password, the refresh token or the email when a login succeeds", async () => {
    users.findLiveByEmail.mockResolvedValue(user());

    const result = await service.login({ email: EMAIL, password: PASSWORD, userAgent: "jest-agent" });

    expect(sink.text()).not.toContain(PASSWORD);
    expect(sink.text()).not.toContain(result.refreshToken);
    expect(sink.text()).not.toContain(result.accessToken);
    expect(sink.text()).not.toContain(EMAIL);
  });
});

describe("SessionService.refresh", () => {
  it("should return invalid without touching the database when no cookie or a malformed one is presented", async () => {
    await expect(service.refresh(undefined)).resolves.toEqual({ kind: "invalid" });
    await expect(service.refresh("short")).resolves.toEqual({ kind: "invalid" });
    await expect(service.refresh(`${PRESENTED}!`)).resolves.toEqual({ kind: "invalid" });

    expect(tokens.findByTokenHash).not.toHaveBeenCalled();
  });

  it("should return invalid when the token hash is unknown", async () => {
    tokens.findByTokenHash.mockResolvedValue(undefined);

    await expect(service.refresh(PRESENTED)).resolves.toEqual({ kind: "invalid" });
    expect(tokens.findByTokenHash).toHaveBeenCalledWith(sha256Hex(PRESENTED));
  });

  it("should return rate_limited with at least one second of retry when the family limiter denies", async () => {
    tokens.findByTokenHash.mockResolvedValue(refreshRow());
    limiter.consumeRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 0 });

    await expect(service.refresh(PRESENTED)).resolves.toEqual({
      kind: "rate_limited",
      retryAfterSeconds: 1,
    });
    expect(limiter.consumeRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ name: "refresh-family", limit: 30, degrade: "fail-open" }),
      FAMILY,
      expect.anything(),
    );
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("should rotate in one transaction and return the new token when the presented token is live", async () => {
    tokens.findByTokenHash.mockResolvedValue(refreshRow());
    tokens.findByIdForUpdate.mockResolvedValue(refreshRow());
    users.findLiveByIdForShare.mockResolvedValue(user());

    const outcome = await service.refresh(PRESENTED);

    expect(outcome).toMatchObject({ kind: "rotated", accessToken: ACCESS_TOKEN });
    expect(tokens.insertToken).toHaveBeenCalledWith(
      expect.objectContaining({ familyId: FAMILY, deviceInfo: "jest-agent" }),
      trx,
    );
    expect(tokens.markRotated).toHaveBeenCalledWith(5, 77, trx);
    // Signed before COMMIT, so a signing failure can never strand a rotated family.
    const signOrder = signerMock.signUserToken.mock.invocationCallOrder[0] ?? 0;
    const commitOrder = trx.commit.mock.invocationCallOrder[0] ?? 0;
    expect(signOrder).toBeLessThan(commitOrder);
    expect(trx.commit).toHaveBeenCalledTimes(1);
  });

  it("should return grace without revoking the family when a rotated token is replayed inside the window", async () => {
    tokens.findByTokenHash.mockResolvedValue(
      refreshRow({
        revokedAt: new Date(NOW.getTime() - 3000),
        revokedReason: RevokedReason.Rotated,
        replacedById: 77,
      }),
    );
    tokens.findById.mockResolvedValue(refreshRow({ id: 77 }));

    await expect(service.refresh(PRESENTED)).resolves.toEqual({ kind: "grace" });

    expect(tokens.revokeFamily).not.toHaveBeenCalled();
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "refresh_token_grace_reuse", userId: 1042 }),
    );
  });

  it("should revoke the whole family when a rotated token is replayed after the grace window", async () => {
    tokens.findByTokenHash.mockResolvedValue(
      refreshRow({
        revokedAt: new Date(NOW.getTime() - 11_000),
        revokedReason: RevokedReason.Rotated,
        replacedById: 77,
      }),
    );

    await expect(service.refresh(PRESENTED)).resolves.toEqual({ kind: "reused" });

    expect(tokens.revokeFamily).toHaveBeenCalledWith(FAMILY, RevokedReason.ReuseDetected, trx);
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "refresh_token_reuse_detected", familyId: FAMILY }),
    );
  });

  it("should revoke the family when the successor of a grace-window token is no longer live", async () => {
    tokens.findByTokenHash.mockResolvedValue(
      refreshRow({
        revokedAt: new Date(NOW.getTime() - 3000),
        revokedReason: RevokedReason.Rotated,
        replacedById: 77,
      }),
    );
    tokens.findById.mockResolvedValue(
      refreshRow({ id: 77, revokedAt: NOW, revokedReason: RevokedReason.Rotated }),
    );

    await expect(service.refresh(PRESENTED)).resolves.toEqual({ kind: "reused" });
    expect(tokens.revokeFamily).toHaveBeenCalledWith(FAMILY, RevokedReason.ReuseDetected, trx);
  });

  it("should revoke the family when a rotated token has no recorded successor", async () => {
    tokens.findByTokenHash.mockResolvedValue(
      refreshRow({
        revokedAt: new Date(NOW.getTime() - 1000),
        revokedReason: RevokedReason.Rotated,
        replacedById: null,
      }),
    );

    await expect(service.refresh(PRESENTED)).resolves.toEqual({ kind: "reused" });
  });

  it("should return invalid without revoking anything when the token was revoked for another reason", async () => {
    for (const reason of [
      RevokedReason.Logout,
      RevokedReason.PasswordChanged,
      RevokedReason.StatusChanged,
    ]) {
      tokens.findByTokenHash.mockResolvedValue(refreshRow({ revokedAt: NOW, revokedReason: reason }));

      await expect(service.refresh(PRESENTED)).resolves.toEqual({ kind: "invalid" });
    }
    expect(tokens.revokeFamily).not.toHaveBeenCalled();
  });

  it("should return invalid when the presented token has expired", async () => {
    tokens.findByTokenHash.mockResolvedValue(
      refreshRow({ expiresAt: new Date(NOW.getTime() - 1000) }),
    );

    await expect(service.refresh(PRESENTED)).resolves.toEqual({ kind: "invalid" });
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("should revoke the family and return suspended when the user was suspended meanwhile", async () => {
    tokens.findByTokenHash.mockResolvedValue(refreshRow());
    tokens.findByIdForUpdate.mockResolvedValue(refreshRow());
    users.findLiveByIdForShare.mockResolvedValue(user({ status: "suspended" }));

    await expect(service.refresh(PRESENTED)).resolves.toEqual({ kind: "suspended" });

    expect(tokens.revokeFamily).toHaveBeenCalledWith(FAMILY, RevokedReason.StatusChanged, trx);
    expect(trx.commit).toHaveBeenCalledTimes(1);
    expect(tokens.insertToken).not.toHaveBeenCalled();
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "refresh_refused_suspended", userId: 1042 }),
    );
  });

  it("should return invalid and roll back when the account was soft-deleted meanwhile", async () => {
    tokens.findByTokenHash.mockResolvedValue(refreshRow());
    tokens.findByIdForUpdate.mockResolvedValue(refreshRow());
    users.findLiveByIdForShare.mockResolvedValue(undefined);

    await expect(service.refresh(PRESENTED)).resolves.toEqual({ kind: "invalid" });
    expect(trx.rollback).toHaveBeenCalledTimes(1);
  });

  it("should re-judge as grace when a concurrent refresh rotated the row first", async () => {
    tokens.findByTokenHash.mockResolvedValue(refreshRow());
    users.findLiveByIdForShare.mockResolvedValue(user());
    tokens.findByIdForUpdate.mockResolvedValue(
      refreshRow({
        revokedAt: new Date(NOW.getTime() - 1000),
        revokedReason: RevokedReason.Rotated,
        replacedById: 77,
      }),
    );
    tokens.findById.mockResolvedValue(refreshRow({ id: 77 }));

    await expect(service.refresh(PRESENTED)).resolves.toEqual({ kind: "grace" });

    expect(trx.rollback).toHaveBeenCalledTimes(1);
    expect(tokens.insertToken).not.toHaveBeenCalled();
  });

  it("should roll back and throw when the rotation update affects no row", async () => {
    tokens.findByTokenHash.mockResolvedValue(refreshRow());
    tokens.findByIdForUpdate.mockResolvedValue(refreshRow());
    users.findLiveByIdForShare.mockResolvedValue(user());
    tokens.markRotated.mockResolvedValue(0);

    await expect(service.refresh(PRESENTED)).rejects.toThrow("refresh_token_rotation_conflict");
    expect(trx.rollback).toHaveBeenCalledTimes(1);
  });

  it("should lock the user FOR SHARE before the token row and re-check expiry under both locks", async () => {
    tokens.findByTokenHash.mockResolvedValue(refreshRow());
    users.findLiveByIdForShare.mockResolvedValue(user());
    tokens.findByIdForUpdate.mockResolvedValue(refreshRow({ expiresAt: new Date(NOW.getTime() - 1) }));

    await expect(service.refresh(PRESENTED)).resolves.toEqual({ kind: "invalid" });

    const shareOrder = users.findLiveByIdForShare.mock.invocationCallOrder[0] ?? 0;
    const tokenOrder = tokens.findByIdForUpdate.mock.invocationCallOrder[0] ?? 0;
    expect(shareOrder).toBeGreaterThan(0);
    expect(shareOrder).toBeLessThan(tokenOrder);
    expect(tokens.insertToken).not.toHaveBeenCalled();
    expect(trx.rollback).toHaveBeenCalledTimes(1);
  });

  it("should return invalid without locking the token when the user is gone", async () => {
    tokens.findByTokenHash.mockResolvedValue(refreshRow());
    users.findLiveByIdForShare.mockResolvedValue(undefined);

    await expect(service.refresh(PRESENTED)).resolves.toEqual({ kind: "invalid" });
    expect(tokens.findByIdForUpdate).not.toHaveBeenCalled();
  });

  it("should return invalid when the locked row disappeared before the rotation", async () => {
    tokens.findByTokenHash.mockResolvedValue(refreshRow());
    users.findLiveByIdForShare.mockResolvedValue(user());
    tokens.findByIdForUpdate.mockResolvedValue(undefined);

    await expect(service.refresh(PRESENTED)).resolves.toEqual({ kind: "invalid" });
    expect(trx.rollback).toHaveBeenCalledTimes(1);
  });
});

describe("SessionService.logout", () => {
  it("should revoke the presented token's family when the cookie is known", async () => {
    tokens.findByTokenHash.mockResolvedValue(refreshRow());

    await service.logout(PRESENTED);

    expect(tokens.revokeFamily).toHaveBeenCalledWith(FAMILY, RevokedReason.Logout, trx);
    expect(sink.lines()).toContainEqual(expect.objectContaining({ message: "logout", userId: 1042 }));
  });

  it("should revoke a family whose presented row is itself already revoked", async () => {
    tokens.findByTokenHash.mockResolvedValue(
      refreshRow({ revokedAt: NOW, revokedReason: RevokedReason.Rotated }),
    );

    await service.logout(PRESENTED);

    expect(tokens.revokeFamily).toHaveBeenCalledWith(FAMILY, RevokedReason.Logout, trx);
  });

  it("should do nothing and never throw when the cookie is absent, malformed or unknown", async () => {
    tokens.findByTokenHash.mockResolvedValue(undefined);

    await expect(service.logout(undefined)).resolves.toBeUndefined();
    await expect(service.logout("nonsense")).resolves.toBeUndefined();
    await expect(service.logout(PRESENTED)).resolves.toBeUndefined();

    expect(tokens.revokeFamily).not.toHaveBeenCalled();
  });

  it("should lock the user FOR UPDATE before revoking the family, in one transaction (ADR 0020)", async () => {
    tokens.findByTokenHash.mockResolvedValue(refreshRow());
    users.findLiveByIdForUpdate.mockResolvedValue(user());

    await service.logout(PRESENTED);

    expect(users.findLiveByIdForUpdate).toHaveBeenCalledWith(1042, trx);
    const lockOrder = users.findLiveByIdForUpdate.mock.invocationCallOrder[0] ?? 0;
    const revokeOrder = tokens.revokeFamily.mock.invocationCallOrder[0] ?? 0;
    const commitOrder = trx.commit.mock.invocationCallOrder[0] ?? 0;
    expect(lockOrder).toBeGreaterThan(0);
    expect(lockOrder).toBeLessThan(revokeOrder);
    expect(revokeOrder).toBeLessThan(commitOrder);
    expect(dbMock.transaction).toHaveBeenCalledTimes(1);
  });

  it("should revoke nothing, roll back and log nothing when the user no longer exists", async () => {
    tokens.findByTokenHash.mockResolvedValue(refreshRow());
    users.findLiveByIdForUpdate.mockResolvedValue(undefined);

    await expect(service.logout(PRESENTED)).resolves.toBeUndefined();

    expect(tokens.revokeFamily).not.toHaveBeenCalled();
    expect(trx.rollback).toHaveBeenCalledTimes(1);
    expect(trx.commit).not.toHaveBeenCalled();
    expect(sink.lines().map((line) => line.message)).not.toContain("logout");
  });

  it("should roll back and rethrow when the family revocation fails, never committing", async () => {
    tokens.findByTokenHash.mockResolvedValue(refreshRow());
    tokens.revokeFamily.mockRejectedValue(new Error("connection lost"));

    await expect(service.logout(PRESENTED)).rejects.toThrow("connection lost");

    expect(trx.commit).not.toHaveBeenCalled();
    expect(trx.rollback).toHaveBeenCalledTimes(1);
  });
});

describe("SessionService reuse-detection revocation lock order (ADR 0020)", () => {
  const reused = (): RefreshToken =>
    refreshRow({
      revokedAt: new Date(NOW.getTime() - 11_000),
      revokedReason: RevokedReason.Rotated,
      replacedById: 77,
    });

  it("should lock the user FOR UPDATE before revoking the family with reuse_detected", async () => {
    tokens.findByTokenHash.mockResolvedValue(reused());
    users.findLiveByIdForUpdate.mockResolvedValue(user());

    await expect(service.refresh(PRESENTED)).resolves.toEqual({ kind: "reused" });

    expect(users.findLiveByIdForUpdate).toHaveBeenCalledWith(1042, trx);
    const lockOrder = users.findLiveByIdForUpdate.mock.invocationCallOrder[0] ?? 0;
    const revokeOrder = tokens.revokeFamily.mock.invocationCallOrder[0] ?? 0;
    expect(lockOrder).toBeGreaterThan(0);
    expect(lockOrder).toBeLessThan(revokeOrder);
    expect(tokens.revokeFamily).toHaveBeenCalledWith(FAMILY, RevokedReason.ReuseDetected, trx);
  });

  it("should not take any lock on the grace path, which only reads", async () => {
    tokens.findByTokenHash.mockResolvedValue(
      refreshRow({
        revokedAt: new Date(NOW.getTime() - 3000),
        revokedReason: RevokedReason.Rotated,
        replacedById: 77,
      }),
    );
    tokens.findById.mockResolvedValue(refreshRow({ id: 77 }));

    await expect(service.refresh(PRESENTED)).resolves.toEqual({ kind: "grace" });

    expect(dbMock.transaction).not.toHaveBeenCalled();
    expect(users.findLiveByIdForUpdate).not.toHaveBeenCalled();
  });

  it("should still answer reused and revoke nothing when the user was soft-deleted meanwhile", async () => {
    tokens.findByTokenHash.mockResolvedValue(reused());
    users.findLiveByIdForUpdate.mockResolvedValue(undefined);

    await expect(service.refresh(PRESENTED)).resolves.toEqual({ kind: "reused" });

    expect(tokens.revokeFamily).not.toHaveBeenCalled();
  });

  it("should re-judge a concurrently revoked row under the locks and revoke the family once when it was reuse", async () => {
    tokens.findByTokenHash.mockResolvedValue(refreshRow());
    users.findLiveByIdForShare.mockResolvedValue(user());
    tokens.findByIdForUpdate.mockResolvedValue(reused());

    await expect(service.refresh(PRESENTED)).resolves.toEqual({ kind: "reused" });

    expect(tokens.revokeFamily).toHaveBeenCalledTimes(1);
    expect(tokens.revokeFamily).toHaveBeenCalledWith(FAMILY, RevokedReason.ReuseDetected, trx);
  });
});

describe("SessionService.listLiveFamilies", () => {
  it("should delegate to the repository with the injected clock's now, the cursor and the limit", async () => {
    const families = [{ familyId: FAMILY }];
    tokens.listLiveFamilies.mockResolvedValue(families);
    const cursor = { createdAt: "2026-09-18T10:00:00.000001Z", familyId: FAMILY };

    await expect(service.listLiveFamilies(1042, cursor, 20)).resolves.toBe(families);

    expect(tokens.listLiveFamilies).toHaveBeenCalledWith(1042, NOW, cursor, 20);
  });
});

describe("SessionService revocation primitives", () => {
  it("should revoke every family of a user when revokeAllForUser is called inside a caller transaction", async () => {
    await expect(
      service.revokeAllForUser(trx as unknown as Knex, 1042, RevokedReason.PasswordReset),
    ).resolves.toBe(2);

    expect(tokens.revokeAllForUser).toHaveBeenCalledWith(1042, RevokedReason.PasswordReset, trx);
  });

  it("should keep one family when revokeAllExceptFamily names it", async () => {
    await service.revokeAllExceptFamily(
      trx as unknown as Knex,
      1042,
      FAMILY,
      RevokedReason.PasswordChanged,
    );

    expect(tokens.revokeAllForUser).toHaveBeenCalledWith(
      1042,
      RevokedReason.PasswordChanged,
      trx,
      FAMILY,
    );
  });

  it("should resolve the family only when the presented token belongs to the caller", async () => {
    tokens.findByTokenHash.mockResolvedValue(refreshRow());
    await expect(service.familyOfOwnToken(PRESENTED, 1042)).resolves.toBe(FAMILY);

    await expect(service.familyOfOwnToken(PRESENTED, 999)).resolves.toBeUndefined();

    tokens.findByTokenHash.mockResolvedValue(undefined);
    await expect(service.familyOfOwnToken(PRESENTED, 1042)).resolves.toBeUndefined();
    await expect(service.familyOfOwnToken(undefined, 1042)).resolves.toBeUndefined();
    await expect(service.familyOfOwnToken("malformed", 1042)).resolves.toBeUndefined();
  });
});
