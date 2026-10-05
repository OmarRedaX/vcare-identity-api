import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { hmacSha256Hex, randomDigits } from "../../../pkg/utils/crypto";
import { requireAppBaseUrl, requireOtpPepper } from "../../../lib/config/requirements";
import type { Env } from "../../../lib/config/types";
import { TOKENS } from "../../../lib/di/tokens";
import type { EmailPort } from "../../../lib/email/types";
import type { JobHandler, JobResult, OutboxJob, OutboxJobType } from "../../../lib/outbox/types";
import {
  accountExistsNoticeEmail,
  passwordResetEmail,
  registrationCodeEmail,
} from "../jobs/email-templates";
import * as challenges from "../repository/registration-challenge.repo";
import * as resets from "../repository/password-reset.repo";
import * as users from "../repository/user.repo";

const CODE_LENGTH = 6;

/**
 * The worker's job handlers (ADR 0007) — never reached from a request path.
 *
 * Each one-time secret is generated **here, at send time**, hashed into its row, committed, and only then
 * emailed: a crash after sending re-sends a **new** code that supersedes the first (at-least-once), and the
 * plaintext exists only in this process's memory and the email. Nothing is logged.
 */
@injectable()
export class AuthMailService {
  constructor(
    @inject(TOKENS.Db) private readonly db: Knex,
    @inject(TOKENS.Env) private readonly env: Env,
    @inject(TOKENS.EmailPort) private readonly email: EmailPort,
  ) {}

  /** Registered in `src/worker.ts`; the processor looks a handler up by job type. */
  handlers(): ReadonlyMap<OutboxJobType, JobHandler> {
    return new Map<OutboxJobType, JobHandler>([
      ["send_registration_code", (job, signal) => this.sendRegistrationCode(job, signal)],
      ["send_account_exists_notice", (job, signal) => this.sendAccountExistsNotice(job, signal)],
      ["send_password_reset", (job, signal) => this.sendPasswordReset(job, signal)],
    ]);
  }

  private async sendRegistrationCode(job: OutboxJob, signal: AbortSignal): Promise<JobResult> {
    const pepper = requireOtpPepper(this.env);
    const trx = await this.db.transaction();
    let email: string;
    let code: string;
    try {
      const challenge = await challenges.findByIdForUpdate(job.aggregateId, trx);
      if (
        challenge === undefined ||
        challenge.consumedAt !== null ||
        challenge.invalidatedAt !== null
      ) {
        await trx.commit();
        return "skipped";
      }
      code = randomDigits(CODE_LENGTH);
      email = challenge.email;
      await challenges.markSent(challenge.id, hmacSha256Hex(pepper, code), trx);
      await trx.commit();
    } catch (err) {
      await trx.rollback().catch(() => undefined);
      throw err;
    }

    const template = registrationCodeEmail(code);
    await this.email.send({ to: email, ...template }, signal);
    return "sent";
  }

  private async sendAccountExistsNotice(job: OutboxJob, signal: AbortSignal): Promise<JobResult> {
    const user = await users.findLiveById(job.aggregateId, this.db);
    if (user === undefined) {
      return "skipped";
    }
    const template = accountExistsNoticeEmail(requireAppBaseUrl(this.env));
    await this.email.send({ to: user.email, ...template }, signal);
    return "sent";
  }

  private async sendPasswordReset(job: OutboxJob, signal: AbortSignal): Promise<JobResult> {
    const pepper = requireOtpPepper(this.env);
    const appBaseUrl = requireAppBaseUrl(this.env);
    const trx = await this.db.transaction();
    let email: string;
    let code: string;
    try {
      const reset = await resets.findByIdForUpdate(job.aggregateId, trx);
      if (reset === undefined || reset.usedAt !== null || reset.invalidatedAt !== null) {
        await trx.commit();
        return "skipped";
      }
      const user = await users.findLiveById(reset.userId, trx);
      if (user === undefined) {
        await trx.commit();
        return "skipped";
      }
      code = randomDigits(CODE_LENGTH);
      email = user.email;
      await resets.markSent(reset.id, hmacSha256Hex(pepper, code), trx);
      await trx.commit();
    } catch (err) {
      await trx.rollback().catch(() => undefined);
      throw err;
    }

    const template = passwordResetEmail(code, appBaseUrl);
    await this.email.send({ to: email, ...template }, signal);
    return "sent";
  }
}
