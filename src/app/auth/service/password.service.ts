import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { hmacSha256Hex, timingSafeEqualHex } from "../../../pkg/utils/crypto";
import { isPast } from "../../../pkg/utils/time";
import { requireOtpPepper } from "../../../lib/config/requirements";
import type { Env } from "../../../lib/config/types";
import { TOKENS } from "../../../lib/di/tokens";
import { AccountSuspended, Unauthorized } from "../../../lib/error/errors";
import type { Logger } from "../../../lib/logger/logger";
import { enqueue } from "../../../lib/outbox/outbox.repo";
import type { PasswordHasher } from "../../../lib/password/password-hasher";
import type { Clock } from "../../../lib/time/types";
import { RevokedReason } from "../enums";
import { InvalidCredentials, InvalidResetCode } from "../errors";
import * as resets from "../repository/password-reset.repo";
import * as users from "../repository/user.repo";
import type { ChangePasswordInput, ResetCheck, ResetPasswordInput } from "../types";
import type { SessionService } from "./session.service";

const MAX_CODE_ATTEMPTS = 5;
/** Compared against when there is no candidate row, so the HMAC work is identical on every path. */
const DUMMY_CODE_HASH = "0".repeat(64);

/**
 * Forgot / reset / change password. Reset consumes a typed 6-digit code (ADR 0017) and answers **every**
 * failure — unknown email included — with the same `400 ValidationFailed field=code` after the same work
 * (BR-20a). argon2 always runs before a transaction opens.
 */
@injectable()
export class PasswordService {
  constructor(
    @inject(TOKENS.Db) private readonly db: Knex,
    @inject(TOKENS.Logger) private readonly logger: Logger,
    @inject(TOKENS.Clock) private readonly clock: Clock,
    @inject(TOKENS.Env) private readonly env: Env,
    @inject(TOKENS.PasswordHasher) private readonly hasher: PasswordHasher,
    @inject(TOKENS.SessionService) private readonly sessions: SessionService,
  ) {}

  /** Always answers 204 at the route; a live account of any status gets a code (BR-18). */
  async forgot(email: string, requestId: string): Promise<void> {
    const user = await users.findLiveByEmail(email);
    if (user === undefined) {
      return;
    }

    const trx = await this.db.transaction();
    try {
      await resets.invalidateOpenForUser(user.id, trx);
      const resetId = await resets.insertReset(user.id, trx);
      await enqueue(trx, "send_password_reset", resetId, requestId);
      await trx.commit();
    } catch (err) {
      await trx.rollback().catch(() => undefined);
      throw err;
    }

    this.logger.info("password_reset_requested", { userId: user.id });
  }

  async reset(input: ResetPasswordInput): Promise<void> {
    // Always, for every outcome, before the transaction: the hash dominates the response time, so an
    // unknown email costs the same as a wrong code (BR-20a).
    const passwordHash = await this.hasher.hash(input.newPassword);
    const pepper = requireOtpPepper(this.env);
    const now = this.clock.now();

    const trx = await this.db.transaction();
    let outcome: ResetCheck;
    let resetId: number | undefined;
    let attempts = 0;
    let userId: number | undefined;
    let revokedSessions = 0;

    try {
      const user = await users.findLiveByEmail(input.email, trx);
      const reset = user === undefined ? undefined : await resets.findLatestOpenForUpdate(user.id, trx);
      resetId = reset?.id;
      attempts = reset?.attempts ?? 0;

      if (user === undefined || reset === undefined) {
        outcome = "no_reset";
      } else if (reset.codeHash === null || reset.expiresAt === null) {
        outcome = "not_sent";
      } else if (isPast(reset.expiresAt, now)) {
        outcome = "expired";
      } else if (!timingSafeEqualHex(hmacSha256Hex(pepper, input.code), reset.codeHash)) {
        const exhausted = reset.attempts + 1 >= MAX_CODE_ATTEMPTS;
        await resets.recordFailedAttempt(reset.id, exhausted, trx);
        attempts = reset.attempts + 1;
        outcome = exhausted ? "exhausted" : "mismatch";
      } else if ((await users.updatePasswordHash(user.id, passwordHash, trx)) === 0) {
        // Soft-deleted between the read and the update: indistinguishable from an unknown email.
        outcome = "no_reset";
      } else {
        const used = await resets.markUsed(reset.id, trx);
        if (used !== 1) {
          // The row is locked FOR UPDATE, so this cannot happen; never silently accept a reset.
          throw new Error("password_reset_use_conflict");
        }
        await resets.invalidateOpenForUser(user.id, trx);
        revokedSessions = await this.sessions.revokeAllForUser(
          trx,
          user.id,
          RevokedReason.PasswordReset,
        );
        userId = user.id;
        outcome = "match";
      }

      // Committed for every outcome, so a failed attempt's counter persists (BR-19).
      await trx.commit();
    } catch (err) {
      await trx.rollback().catch(() => undefined);
      throw err;
    }

    if (outcome !== "match" || userId === undefined) {
      if (outcome === "no_reset" || outcome === "not_sent" || outcome === "expired") {
        // No candidate row was compared: do the same HMAC and constant-time compare anyway.
        timingSafeEqualHex(hmacSha256Hex(pepper, input.code), DUMMY_CODE_HASH);
      }
      this.logger.warn("password_reset_failed", { resetId, attempts, outcome });
      throw InvalidResetCode;
    }

    this.logger.info("password_reset_completed", { userId, revokedSessions });
  }

  /** Requires the current password and keeps only the caller's own presented family alive (BR-21). */
  async change(input: ChangePasswordInput): Promise<void> {
    const user = await users.findLiveById(input.userId);
    if (user === undefined) {
      throw Unauthorized;
    }
    if (user.isSuspended()) {
      throw AccountSuspended;
    }

    const { ok } = await this.hasher.verify(user.passwordHash, input.currentPassword);
    if (!ok) {
      this.logger.warn("password_change_failed", { userId: user.id });
      throw InvalidCredentials;
    }

    const passwordHash = await this.hasher.hash(input.newPassword);
    const keepFamily = await this.sessions.familyOfOwnToken(
      input.presentedRefreshToken,
      user.id,
    );

    const trx = await this.db.transaction();
    let revokedSessions: number;
    try {
      if ((await users.updatePasswordHash(user.id, passwordHash, trx)) === 0) {
        await trx.rollback();
        throw Unauthorized;
      }
      revokedSessions = await this.sessions.revokeAllExceptFamily(
        trx,
        user.id,
        keepFamily,
        RevokedReason.PasswordChanged,
      );
      await trx.commit();
    } catch (err) {
      await trx.rollback().catch(() => undefined);
      throw err;
    }

    this.logger.info("password_changed", {
      userId: user.id,
      revokedSessions,
      keptCurrentSession: keepFamily !== undefined,
    });
  }
}
