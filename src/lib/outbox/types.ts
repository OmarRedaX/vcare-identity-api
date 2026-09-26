import type { Logger } from "../logger/logger";
import type { Knex } from "knex";

/** Widened only by a migration that also widens `chk_outbox_jobs_type`. */
export type OutboxJobType =
  | "send_registration_code"
  | "send_account_exists_notice"
  | "send_password_reset";

/** The claimed job: ids only, never PII and never a secret (BR-28). */
export interface OutboxJob {
  id: number;
  type: OutboxJobType;
  aggregateId: number;
  attempts: number;
  requestId: string;
}

export type JobResult = "sent" | "skipped";

export type JobHandler = (job: OutboxJob, signal: AbortSignal) => Promise<JobResult>;

export interface OutboxProcessorOptions {
  db: Knex;
  logger: Logger;
  handlers: ReadonlyMap<OutboxJobType, JobHandler>;
  batchSize: number;
  maxAttempts: number;
  concurrency?: number;
  leaseSeconds?: number;
}

export type FinishedStatus = "done" | "dead";

/** Raw row shape as `pg` returns it: BIGINT arrives as a string. */
export interface OutboxJobRow {
  id: string | number;
  type: string;
  aggregate_id: string | number;
  attempts: number;
  request_id: string;
}
