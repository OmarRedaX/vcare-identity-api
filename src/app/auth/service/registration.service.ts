import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { hmacSha256Hex, timingSafeEqualHex } from "../../../pkg/utils/crypto";
import { isPast } from "../../../pkg/utils/time";
import { requireOtpPepper } from "../../../lib/config/requirements";
import type { Env } from "../../../lib/config/types";
import { TOKENS } from "../../../lib/di/tokens";
import type { Logger } from "../../../lib/logger/logger";
import { enqueue } from "../../../lib/outbox/outbox.repo";
import type { Clock } from "../../../lib/time/types";
import type { PasswordHasher } from "../../../lib/password/password-hasher";
import type { User } from "../entity/user.entity";
import { UserStatus } from "../enums";
import { EmailAlreadyRegistered, InvalidRegistrationCode } from "../errors";
import * as challenges from "../repository/registration-challenge.repo";
import * as users from "../repository/user.repo";
import type { ChallengeCheck, RegisterCompleteInput } from "../types";

const MAX_CODE_ATTEMPTS = 5;
const UNIQUE_VIOLATION = "23505";
/** Compared against when there is no candidate row, so the HMAC work is identical on every path. */
const DUMMY_CODE_HASH = "0".repeat(64);

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * Email-first registration (ADR 0006). `start` never reveals whether the email is known (BR-1) and
 * `complete` answers every code failure with the same `400 ValidationFailed field=code` (BR-3).
 * argon2 always runs before the transaction opens, so a pooled connection is never held while hashing.
 */
@injectable()
export class RegistrationService {
  constructor(
    @inject(TOKENS.Db) private readonly db: Knex,
    @inject(TOKENS.Logger) private readonly logger: Logger,
    @inject(TOKENS.Clock) private readonly clock: Clock,
    @inject(TOKENS.Env) private readonly env: Env,
    @inject(TOKENS.PasswordHasher) private readonly hasher: PasswordHasher,
  ) {}

  /** One transaction; the outbox job commits with the row it follows (ADR 0007). */
  async start(email: string, requestId: string): Promise<void> {
    const trx = await this.db.transaction();
    try {
      await challenges.lockEmailForStart(email, trx);
      const existing = await users.findLiveByEmail(email, trx);
      if (existing === undefined) {
        await challenges.invalidateOpenForEmail(email, trx);
        const challengeId = await challenges.insertChallenge(email, trx);
        await enqueue(trx, "send_registration_code", challengeId, requestId);
      } else {
        await enqueue(trx, "send_account_exists_notice", existing.id, requestId);
      }
      await trx.commit();
    } catch (err) {
      await trx.rollback().catch(() => undefined);
      throw err;
    }

    // Neither the email nor the outcome is logged: the two paths must be indistinguishable.
    this.logger.info("registration_start_accepted");
  }

  async complete(input: RegisterCompleteInput): Promise<User> {
    // Before the transaction: argon2 is the dominant cost and must not hold a connection.
    const passwordHash = await this.hasher.hash(input.password);
    const pepper = requireOtpPepper(this.env);
    const now = this.clock.now();

    const trx = await this.db.transaction();
    let outcome: ChallengeCheck;
    let challengeId: number | undefined;
    let attempts = 0;
    let created: User | undefined;

    try {
      const challenge = await challenges.findLatestOpenForUpdate(input.email, trx);
      challengeId = challenge?.id;
      attempts = challenge?.attempts ?? 0;

      if (challenge === undefined) {
        outcome = "no_challenge";
      } else if (challenge.codeHash === null || challenge.expiresAt === null) {
        outcome = "not_sent";
      } else if (isPast(challenge.expiresAt, now)) {
        outcome = "expired";
      } else if (!timingSafeEqualHex(hmacSha256Hex(pepper, input.code), challenge.codeHash)) {
        const exhausted = challenge.attempts + 1 >= MAX_CODE_ATTEMPTS;
        await challenges.recordFailedAttempt(challenge.id, exhausted, trx);
        attempts = challenge.attempts + 1;
        outcome = exhausted ? "exhausted" : "mismatch";
      } else {
        await challenges.markConsumed(challenge.id, trx);
        created = await users.insertUser(
          {
            email: input.email,
            phone: input.phone ?? null,
            passwordHash,
            fullName: input.fullName,
            role: input.role,
            // `input.role` is the RBAC literal union; UserRole holds the same values (asserted in a unit test).
            status: input.role === "doctor" ? UserStatus.Pending : UserStatus.Active,
            timezone: input.timezone,
            locale: input.locale,
          },
          trx,
        );
        outcome = "match";
      }

      // Committed for every outcome, so a failed attempt's counter persists (BR-3).
      await trx.commit();
    } catch (err) {
      await trx.rollback().catch(() => undefined);
      if (isUniqueViolation(err)) {
        // A concurrent registration won the race; the challenge stays unconsumed (BR-5).
        throw EmailAlreadyRegistered;
      }
      throw err;
    }

    if (outcome !== "match" || created === undefined) {
      if (outcome === "no_challenge" || outcome === "not_sent" || outcome === "expired") {
        // No candidate row was compared: do the same HMAC and constant-time compare anyway.
        timingSafeEqualHex(hmacSha256Hex(pepper, input.code), DUMMY_CODE_HASH);
      }
      this.logger.warn("registration_code_failed", {
        challengeId,
        attempts,
        exhausted: outcome === "exhausted",
      });
      throw InvalidRegistrationCode;
    }

    this.logger.info("user_registered", {
      userId: created.id,
      role: created.role,
      status: created.status,
    });
    return created;
  }
}
