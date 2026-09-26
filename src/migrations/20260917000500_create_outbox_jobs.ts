import type { Knex } from "knex";

/**
 * outbox_jobs: the transactional outbox (ADR 0007). A row is inserted in the same transaction as the
 * business row it follows and holds **ids only** — never PII, never a secret; the one-time code is generated
 * by the worker at send time (BR-28). `last_error` holds an error class name only.
 * `aggregate_id` is a logical reference: no FK (jobs outlive their aggregate) and no index (nothing queries
 * by it). A job table, not a business table: no `deleted_at`, purged by `completed_at`.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
      CREATE TABLE outbox_jobs (
          id           BIGSERIAL PRIMARY KEY,
          type         VARCHAR(48)  NOT NULL,
          aggregate_id BIGINT       NOT NULL,
          status       VARCHAR(16)  NOT NULL,
          attempts     SMALLINT     NOT NULL,
          run_after    TIMESTAMPTZ  NOT NULL,
          locked_until TIMESTAMPTZ  NULL,
          last_error   VARCHAR(500) NULL,
          request_id   UUID         NOT NULL,
          created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
          updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
          completed_at TIMESTAMPTZ  NULL,

          CONSTRAINT chk_outbox_jobs_type CHECK (
              type IN ('send_registration_code', 'send_account_exists_notice', 'send_password_reset')
          ),
          CONSTRAINT chk_outbox_jobs_status CHECK (status IN ('pending', 'processing', 'done', 'dead')),
          CONSTRAINT chk_outbox_jobs_attempts CHECK (attempts >= 0),
          CONSTRAINT chk_outbox_jobs_lease CHECK ((status = 'processing') = (locked_until IS NOT NULL)),
          CONSTRAINT chk_outbox_jobs_completed CHECK (
              (status IN ('done', 'dead')) = (completed_at IS NOT NULL)
          )
      );
  `);

  // Worker claim:
  //   ... WHERE status = 'pending' AND run_after <= now() ORDER BY run_after LIMIT $1 FOR UPDATE SKIP LOCKED
  // Lag metric: SELECT min(run_after) ... WHERE status = 'pending' AND run_after <= now()
  await knex.raw(`
      CREATE INDEX idx_outbox_jobs_run_after_pending ON outbox_jobs (run_after) WHERE status = 'pending';
  `);

  // Lease reclaim:
  //   ... WHERE status = 'processing' AND locked_until < now() ... FOR UPDATE SKIP LOCKED
  await knex.raw(`
      CREATE INDEX idx_outbox_jobs_locked_until_processing ON outbox_jobs (locked_until)
          WHERE status = 'processing';
  `);

  // Worker purge: done after 7 days, dead after 30 days:
  //   ... WHERE status = $1 AND completed_at < now() - make_interval(days => $2) LIMIT $3
  await knex.raw(`
      CREATE INDEX idx_outbox_jobs_completed_at ON outbox_jobs (status, completed_at)
          WHERE status IN ('done', 'dead');
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS outbox_jobs;`);
}
