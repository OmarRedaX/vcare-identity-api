import type { Knex } from "knex";
import type { Logger } from "../logger/logger";
import { requestContext } from "../request-id/context";
import { retryDelaySeconds } from "./backoff";
import { OutboxDeliveryError } from "./delivery-error";
import {
  claim,
  markDead,
  markDone,
  markRetry,
  oldestDuePendingAgeSeconds,
  reclaimExpiredLeases,
} from "./outbox.repo";
import type { JobHandler, OutboxJob, OutboxJobType, OutboxProcessorOptions } from "./types";

const DEFAULT_CONCURRENCY = 4;
/** Longer than the worst case of a job (5 s provider timeout + two short statements) behind a full batch. */
const DEFAULT_LEASE_SECONDS = 120;
const LAG_METRIC_INTERVAL_MS = 60_000;

/** One tick of the outbox loop (ADR 0007): reclaim, claim, run, finish. Never runs inside a request. */
export class OutboxProcessor {
  private readonly db: Knex;
  private readonly logger: Logger;
  private readonly handlers: ReadonlyMap<OutboxJobType, JobHandler>;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly concurrency: number;
  private readonly leaseSeconds: number;
  private lastLagMetricAt = 0;

  constructor(options: OutboxProcessorOptions) {
    this.db = options.db;
    this.logger = options.logger;
    this.handlers = options.handlers;
    this.batchSize = options.batchSize;
    this.maxAttempts = options.maxAttempts;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  }

  async tick(signal: AbortSignal): Promise<void> {
    const reclaimed = await reclaimExpiredLeases(this.batchSize, this.maxAttempts, this.db);
    if (reclaimed > 0) {
      this.logger.warn("outbox_lease_reclaimed", { count: reclaimed });
    }

    const jobs = await claim(this.batchSize, this.leaseSeconds, this.db);
    if (jobs.length > 0) {
      await this.runAll(jobs, signal);
    }

    await this.reportLag();
  }

  private async runAll(jobs: readonly OutboxJob[], signal: AbortSignal): Promise<void> {
    const queue = [...jobs];
    const workers: Promise<void>[] = [];

    const next = async (): Promise<void> => {
      for (;;) {
        // Shutdown: stop starting new jobs; the leases of the rest expire and are reclaimed.
        if (signal.aborted) {
          return;
        }
        const job = queue.shift();
        if (job === undefined) {
          return;
        }
        await this.runOne(job, signal);
      }
    };

    for (let i = 0; i < Math.min(this.concurrency, queue.length); i += 1) {
      workers.push(next());
    }
    await Promise.all(workers);
  }

  private runOne(job: OutboxJob, signal: AbortSignal): Promise<void> {
    // The job's own request id, so every worker log line joins the originating request's trace.
    return requestContext.run({ requestId: job.requestId }, async () => {
      const handler = this.handlers.get(job.type);
      if (handler === undefined) {
        await markDead(job.id, "UnknownJobType", this.db);
        this.logger.error("outbox_job_dead", { jobId: job.id, type: job.type, errorClass: "UnknownJobType" });
        this.logger.metric("outbox_dead_jobs", 1, "Count", { type: job.type });
        return;
      }

      try {
        const result = await handler(job, signal);
        await markDone(job.id, this.db);
        if (result === "skipped") {
          this.logger.info("outbox_job_skipped", { jobId: job.id, type: job.type });
          return;
        }
        this.logger.info("outbox_job_sent", { jobId: job.id, type: job.type, attempts: job.attempts });
      } catch (err) {
        await this.finishFailure(job, err);
      }
    });
  }

  private async finishFailure(job: OutboxJob, err: unknown): Promise<void> {
    const delivery =
      err instanceof OutboxDeliveryError
        ? err
        : new OutboxDeliveryError(err instanceof Error ? err.name : "UnknownError", true);

    if (delivery.retryable && job.attempts < this.maxAttempts) {
      await markRetry(job.id, retryDelaySeconds(job.attempts), delivery.errorClass, this.db);
      this.logger.warn("outbox_job_retry", {
        jobId: job.id,
        type: job.type,
        attempts: job.attempts,
        errorClass: delivery.errorClass,
      });
      return;
    }

    await markDead(job.id, delivery.errorClass, this.db);
    this.logger.error("outbox_job_dead", {
      jobId: job.id,
      type: job.type,
      errorClass: delivery.errorClass,
    });
    this.logger.metric("outbox_dead_jobs", 1, "Count", { type: job.type });
  }

  private async reportLag(): Promise<void> {
    const now = Date.now();
    if (now - this.lastLagMetricAt < LAG_METRIC_INTERVAL_MS) {
      return;
    }
    this.lastLagMetricAt = now;
    const age = await oldestDuePendingAgeSeconds(this.db);
    this.logger.metric("outbox_oldest_pending_age_s", age, "Seconds");
  }
}
