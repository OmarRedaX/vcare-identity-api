import type Redis from "ioredis";
import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { randomToken, randomUuid, sha256Hex } from "../../../pkg/utils/crypto";
import { addTime, isPast, subtractTime } from "../../../pkg/utils/time";
import { REFRESH_TOKEN_PATTERN, REFRESH_TOKEN_TTL_DAYS } from "../../../lib/auth/constants";
import type { TokenSigner } from "../../../lib/auth/jwt";
import type { Env } from "../../../lib/config/types";
import { TOKENS } from "../../../lib/di/tokens";
import type { Logger } from "../../../lib/logger/logger";
import type { PasswordHasher } from "../../../lib/password/password-hasher";
import { consumeRateLimit, logRateLimited } from "../../../lib/rate-limit/rate-limit";
import type { RateLimitDeps, SlidingWindowOptions } from "../../../lib/rate-limit/types";
import type { Clock } from "../../../lib/time/types";
import { AccountSuspended } from "../../../lib/error/errors";
import type { RefreshToken } from "../entity/refresh-token.entity";
import type { User } from "../entity/user.entity";
import { RevokedReason } from "../enums";
import { InvalidCredentials } from "../errors";
import * as refreshTokens from "../repository/refresh-token.repo";
import * as users from "../repository/user.repo";
import type { LoginInput, LoginResult, RefreshOutcome } from "../types";

/** Subject is the token family, which is only known after the database lookup (spec §4.4 step 3). */
const REFRESH_LIMITER: SlidingWindowOptions = {
  name: "refresh-family",
  limit: 30,
  windowMs: 60_000,
  degrade: "fail-open",
};

const DEVICE_INFO_MAX_LENGTH = 255;
/** Unicode control characters (C0 and C1). */
const CONTROL_CHARACTERS = /\p{Cc}/gu;

function deviceInfoOf(userAgent: string | undefined): string | null {
  if (userAgent === undefined) {
    return null;
  }
  const cleaned = userAgent.replace(CONTROL_CHARACTERS, "").slice(0, DEVICE_INFO_MAX_LENGTH);
  return cleaned.length === 0 ? null : cleaned;
}

/**
 * Login, refresh rotation with family-wide reuse detection (ADR 0002, ADR 0005), logout, and the
 * revocation primitives the `users` module and Epic B call inside their own transactions (spec §1.4).
 */
@injectable()
export class SessionService {
  constructor(
    @inject(TOKENS.Db) private readonly db: Knex,
    @inject(TOKENS.Redis) private readonly redis: Redis,
    @inject(TOKENS.Logger) private readonly logger: Logger,
    @inject(TOKENS.Clock) private readonly clock: Clock,
    @inject(TOKENS.Env) private readonly env: Env,
    @inject(TOKENS.PasswordHasher) private readonly hasher: PasswordHasher,
    @inject(TOKENS.TokenSigner) private readonly signer: TokenSigner,
  ) {}

  /**
   * Unknown email and wrong password are answered identically after one argon2 verify (BR-7); the account
   * status is only consulted once the password is correct, so status never leaks (BR-8).
   */
  async login(input: LoginInput): Promise<LoginResult> {
    const user = await users.findLiveByEmail(input.email);

    if (user === undefined) {
      await this.hasher.verifyDummy(input.password);
      this.logger.warn("login_failed", { reason: "unknown_email" });
      this.logger.metric("login_failed", 1, "Count");
      throw InvalidCredentials;
    }

    const { ok, needsRehash } = await this.hasher.verify(user.passwordHash, input.password);
    if (!ok) {
      this.logger.warn("login_failed", { userId: user.id, reason: "wrong_password" });
      this.logger.metric("login_failed", 1, "Count");
      throw InvalidCredentials;
    }

    if (user.isSuspended()) {
      this.logger.warn("login_refused_suspended", { userId: user.id });
      throw AccountSuspended;
    }

    let rehashed: string | undefined;
    if (needsRehash) {
      try {
        rehashed = await this.hasher.hash(input.password);
      } catch {
        // A full hash queue must never fail a valid login (BR-10).
        this.logger.warn("password_rehash_skipped", { userId: user.id });
      }
    }

    const now = this.clock.now();
    const refreshToken = randomToken();
    const trx = await this.db.transaction();
    let accessToken: string;
    let account: User;
    try {
      // The password was verified before this transaction: re-read under a row lock so a reset or
      // suspension that committed in between cannot be followed by a live session (BR-7, rule 7).
      const locked = await users.findLiveByIdForUpdate(user.id, trx);
      if (locked === undefined || locked.passwordHash !== user.passwordHash) {
        this.logger.warn("login_failed", { userId: user.id, reason: "credentials_changed" });
        throw InvalidCredentials;
      }
      if (locked.isSuspended()) {
        this.logger.warn("login_refused_suspended", { userId: user.id });
        throw AccountSuspended;
      }
      account = locked;
      if (rehashed !== undefined) {
        await users.updatePasswordHash(user.id, rehashed, trx);
        this.logger.info("password_rehashed", { userId: user.id });
      }
      await refreshTokens.insertToken(
        {
          userId: user.id,
          familyId: randomUuid(),
          tokenHash: sha256Hex(refreshToken),
          expiresAt: addTime(now, REFRESH_TOKEN_TTL_DAYS, "d"),
          deviceInfo: deviceInfoOf(input.userAgent),
        },
        trx,
      );
      accessToken = await this.signer.signUserToken(locked);
      await trx.commit();
    } catch (err) {
      await trx.rollback().catch(() => undefined);
      throw err;
    }

    this.logger.info("login_succeeded", { userId: user.id });
    return { user: account, accessToken, refreshToken };
  }

  /** The decision table of spec §4.4; the controller maps each outcome to a status and cookie action. */
  async refresh(presentedToken: string | undefined): Promise<RefreshOutcome> {
    if (presentedToken === undefined || !REFRESH_TOKEN_PATTERN.test(presentedToken)) {
      return { kind: "invalid" };
    }

    const row = await refreshTokens.findByTokenHash(sha256Hex(presentedToken));
    if (row === undefined) {
      return { kind: "invalid" };
    }

    const decision = await consumeRateLimit(REFRESH_LIMITER, row.familyId, this.limiterDeps());
    if (!decision.allowed) {
      logRateLimited(REFRESH_LIMITER.name, decision.degraded === true, this.limiterDeps());
      return { kind: "rate_limited", retryAfterSeconds: Math.max(1, decision.retryAfterSeconds) };
    }

    const now = this.clock.now();
    if (row.revokedAt !== null) {
      return this.judgeRevoked(row, now);
    }
    if (isPast(row.expiresAt, now)) {
      return { kind: "invalid" };
    }

    return this.rotate(row.id, now);
  }

  /** Always safe to call: a missing, malformed, unknown or revoked cookie simply revokes nothing (BR-17). */
  async logout(presentedToken: string | undefined): Promise<void> {
    if (presentedToken === undefined || !REFRESH_TOKEN_PATTERN.test(presentedToken)) {
      return;
    }
    const row = await refreshTokens.findByTokenHash(sha256Hex(presentedToken));
    if (row === undefined) {
      return;
    }
    await refreshTokens.revokeFamily(row.familyId, RevokedReason.Logout);
    this.logger.info("logout", { userId: row.userId });
  }

  /** Called by this module (reset), and by `users` / Epic B inside **their** transaction (spec §1.4). */
  revokeAllForUser(conn: Knex, userId: number, reason: RevokedReason): Promise<number> {
    return refreshTokens.revokeAllForUser(userId, reason, conn);
  }

  revokeAllExceptFamily(
    conn: Knex,
    userId: number,
    familyId: string | undefined,
    reason: RevokedReason,
  ): Promise<number> {
    return refreshTokens.revokeAllForUser(userId, reason, conn, familyId);
  }

  /** Resolves the family of a presented cookie, but only when the token belongs to `userId` (BR-21). */
  async familyOfOwnToken(
    presentedToken: string | undefined,
    userId: number,
  ): Promise<string | undefined> {
    if (presentedToken === undefined || !REFRESH_TOKEN_PATTERN.test(presentedToken)) {
      return undefined;
    }
    const row = await refreshTokens.findByTokenHash(sha256Hex(presentedToken));
    return row !== undefined && row.userId === userId ? row.familyId : undefined;
  }

  private limiterDeps(): RateLimitDeps {
    return {
      redis: this.redis,
      logger: this.logger,
      fallbackDivisor: this.env.RATE_LIMIT_FALLBACK_DIVISOR,
      now: () => Date.now(),
    };
  }

  /**
   * A revoked row: only `rotated` can mean reuse. Inside the grace window, with a live successor, the
   * family survives and no cookie is cleared (ADR 0005); otherwise the whole family is revoked (BR-12).
   */
  private async judgeRevoked(token: RefreshToken, now: Date): Promise<RefreshOutcome> {
    if (token.revokedAt === null || token.revokedReason !== RevokedReason.Rotated) {
      return { kind: "invalid" };
    }

    const graceStart = subtractTime(now, this.env.REFRESH_REUSE_GRACE_SECONDS, "s");
    if (token.revokedAt > graceStart && token.replacedById !== null) {
      const successor = await refreshTokens.findById(token.replacedById);
      if (successor !== undefined && successor.isLive(now)) {
        this.logger.info("refresh_token_grace_reuse", { userId: token.userId });
        this.logger.metric("refresh_token_grace_reuse", 1, "Count");
        return { kind: "grace" };
      }
    }

    await refreshTokens.revokeFamily(token.familyId, RevokedReason.ReuseDetected);
    this.logger.warn("refresh_token_reuse_detected", {
      userId: token.userId,
      familyId: token.familyId,
    });
    this.logger.metric("refresh_token_reuse_detected", 1, "Count");
    return { kind: "reused" };
  }

  /** One transaction: lock the presented row, re-read the user, insert the successor, mark rotated. */
  private async rotate(id: number, now: Date): Promise<RefreshOutcome> {
    const nextToken = randomToken();
    const trx = await this.db.transaction();
    try {
      const locked = await refreshTokens.findByIdForUpdate(id, trx);
      if (locked === undefined) {
        await trx.rollback();
        return { kind: "invalid" };
      }
      if (locked.revokedAt !== null) {
        // A concurrent refresh won the race: re-judge outside the transaction (typically "grace").
        await trx.rollback();
        return this.judgeRevoked(locked, now);
      }

      const user = await users.findLiveById(locked.userId, trx);
      if (user === undefined) {
        await trx.rollback();
        return { kind: "invalid" };
      }

      if (user.isSuspended()) {
        await refreshTokens.revokeFamily(locked.familyId, RevokedReason.StatusChanged, trx);
        await trx.commit();
        this.logger.warn("refresh_refused_suspended", { userId: user.id });
        return { kind: "suspended" };
      }

      const newId = await refreshTokens.insertToken(
        {
          userId: locked.userId,
          familyId: locked.familyId,
          tokenHash: sha256Hex(nextToken),
          expiresAt: addTime(now, REFRESH_TOKEN_TTL_DAYS, "d"),
          deviceInfo: locked.deviceInfo,
        },
        trx,
      );
      const rotated = await refreshTokens.markRotated(locked.id, newId, trx);
      if (rotated !== 1) {
        throw new Error("refresh_token_rotation_conflict");
      }

      // Signed before COMMIT so a signing failure can never strand a rotated family.
      const accessToken = await this.signer.signUserToken(user);
      await trx.commit();
      return { kind: "rotated", accessToken, refreshToken: nextToken };
    } catch (err) {
      await trx.rollback().catch(() => undefined);
      throw err;
    }
  }
}
