import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import { withAdvisoryXactLock } from "../../../lib/knex/advisory-lock";
import type { Logger } from "../../../lib/logger/logger";
import { deleteFinishedBatch } from "../../../lib/outbox/outbox.repo";
import * as challenges from "../repository/registration-challenge.repo";
import * as resets from "../repository/password-reset.repo";
import * as refreshTokens from "../repository/refresh-token.repo";
import type { PurgeResult } from "../types";

const BATCH_SIZE = 5000;
const MAX_BATCHES = 20;

/** Fixed per-step keys so two workers never purge the same table at the same time (spec §5.6). */
const LOCK_KEYS = {
  refreshTokens: 0x7661_0001n,
  passwordResets: 0x7661_0002n,
  registrationChallenges: 0x7661_0003n,
  outboxDone: 0x7661_0004n,
  outboxDead: 0x7661_0005n,
} as const;

const OUTBOX_DONE_RETENTION_DAYS = 7;
const OUTBOX_DEAD_RETENTION_DAYS = 30;

/**
 * Retention purges for the module's token and job tables, run by the worker's second loop (BR-31).
 * `users` — and, later, `user_status_changes` — are **never** purged; business rows are soft-deleted only
 * (CLAUDE.md -> Database rules).
 *
 * Each batch is its own short transaction under an advisory lock, so a purge never holds a long
 * transaction and never collides with another worker.
 */
@injectable()
export class PurgeService {
  constructor(
    @inject(TOKENS.Db) private readonly db: Knex,
    @inject(TOKENS.Logger) private readonly logger: Logger,
  ) {}

  async runAll(signal: AbortSignal): Promise<PurgeResult[]> {
    return [
      await this.purge("refresh_tokens", LOCK_KEYS.refreshTokens, signal, (trx) =>
        refreshTokens.deleteExpiredBatch(BATCH_SIZE, trx),
      ),
      await this.purge("password_resets", LOCK_KEYS.passwordResets, signal, (trx) =>
        resets.deleteOldBatch(BATCH_SIZE, trx),
      ),
      await this.purge("registration_challenges", LOCK_KEYS.registrationChallenges, signal, (trx) =>
        challenges.deleteOldBatch(BATCH_SIZE, trx),
      ),
      await this.purge("outbox_jobs_done", LOCK_KEYS.outboxDone, signal, (trx) =>
        deleteFinishedBatch("done", OUTBOX_DONE_RETENTION_DAYS, BATCH_SIZE, trx),
      ),
      await this.purge("outbox_jobs_dead", LOCK_KEYS.outboxDead, signal, (trx) =>
        deleteFinishedBatch("dead", OUTBOX_DEAD_RETENTION_DAYS, BATCH_SIZE, trx),
      ),
    ];
  }

  private async purge(
    table: string,
    lockKey: bigint,
    signal: AbortSignal,
    deleteBatch: (trx: Knex.Transaction) => Promise<number>,
  ): Promise<PurgeResult> {
    let deleted = 0;
    let batches = 0;

    while (batches < MAX_BATCHES && !signal.aborted) {
      const removed = await withAdvisoryXactLock(this.db, lockKey, (trx) => deleteBatch(trx));
      if (removed === undefined) {
        // Another worker holds the lock: leave the rest to it.
        break;
      }
      batches += 1;
      deleted += removed;
      if (removed < BATCH_SIZE) {
        break;
      }
    }

    if (deleted > 0) {
      this.logger.info("purge_completed", { table, deleted, batches });
    }
    return { table, deleted };
  }
}
