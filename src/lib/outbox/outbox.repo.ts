import type { Knex } from "knex";
import { db } from "../knex/knex";
import type { FinishedStatus, OutboxJob, OutboxJobRow, OutboxJobType } from "./types";

const TABLE = "outbox_jobs";

/** Claimed columns only — the row holds no PII and no secret, so there is nothing else to read (BR-28). */
const CLAIM_COLUMNS = ["id", "type", "aggregate_id", "attempts", "request_id"] as const;

function toJob(row: OutboxJobRow): OutboxJob {
  return {
    id: Number(row.id),
    type: row.type as OutboxJobType,
    aggregateId: Number(row.aggregate_id),
    attempts: Number(row.attempts),
    requestId: row.request_id,
  };
}

/**
 * Always called with the caller's transaction, so the job and the row it follows commit together
 * (ADR 0007). `requestId` lets the worker's log lines join the originating request's trace.
 */
export async function enqueue(
  conn: Knex,
  type: OutboxJobType,
  aggregateId: number,
  requestId: string,
): Promise<void> {
  await conn(TABLE).insert({
    type,
    aggregate_id: aggregateId,
    status: "pending",
    attempts: 0,
    run_after: conn.raw("now()"),
    request_id: requestId,
  });
}

/** One worker at a time per job: SKIP LOCKED plus a lease (BR-29). */
export async function claim(
  limit: number,
  leaseSeconds: number,
  conn: Knex = db,
): Promise<OutboxJob[]> {
  const due = conn
    .select("id")
    .from(TABLE)
    .where("status", "pending")
    .andWhere("run_after", "<=", conn.raw("now()"))
    .orderBy("run_after", "asc")
    .limit(limit)
    .forUpdate()
    .skipLocked();

  const rows = await conn(TABLE)
    .whereIn("id", due)
    .update({
      status: "processing",
      attempts: conn.raw("attempts + 1"),
      locked_until: conn.raw("now() + make_interval(secs => ?)", [leaseSeconds]),
      updated_at: conn.raw("now()"),
    })
    .returning([...CLAIM_COLUMNS]);

  return (rows as OutboxJobRow[]).map(toJob);
}

/** A worker that died mid-job leaves a `processing` row; its lease expires and the job runs again. */
export async function reclaimExpiredLeases(
  limit: number,
  maxAttempts: number,
  conn: Knex = db,
): Promise<number> {
  const expired = conn
    .select("id")
    .from(TABLE)
    .where("status", "processing")
    .andWhere("locked_until", "<", conn.raw("now()"))
    .orderBy("locked_until", "asc")
    .limit(limit)
    .forUpdate()
    .skipLocked();

  const rows = await conn(TABLE)
    .whereIn("id", expired)
    .update({
      status: conn.raw("CASE WHEN attempts >= ? THEN 'dead' ELSE 'pending' END", [maxAttempts]),
      run_after: conn.raw("now()"),
      locked_until: null,
      completed_at: conn.raw("CASE WHEN attempts >= ? THEN now() ELSE NULL END", [maxAttempts]),
      last_error: "LeaseExpired",
      updated_at: conn.raw("now()"),
    })
    .returning("id");

  return rows.length;
}

export async function markDone(id: number, conn: Knex = db): Promise<number> {
  return conn(TABLE).where({ id, status: "processing" }).update({
    status: "done",
    completed_at: conn.raw("now()"),
    locked_until: null,
    last_error: null,
    updated_at: conn.raw("now()"),
  });
}

export async function markRetry(
  id: number,
  delaySeconds: number,
  errorClass: string,
  conn: Knex = db,
): Promise<number> {
  return conn(TABLE)
    .where({ id, status: "processing" })
    .update({
      status: "pending",
      run_after: conn.raw("now() + make_interval(secs => ?)", [delaySeconds]),
      locked_until: null,
      last_error: errorClass,
      updated_at: conn.raw("now()"),
    });
}

export async function markDead(id: number, errorClass: string, conn: Knex = db): Promise<number> {
  return conn(TABLE).where({ id, status: "processing" }).update({
    status: "dead",
    completed_at: conn.raw("now()"),
    locked_until: null,
    last_error: errorClass,
    updated_at: conn.raw("now()"),
  });
}

/** Feeds the `outbox_oldest_pending_age_s` metric; 0 when nothing is due. */
export async function oldestDuePendingAgeSeconds(conn: Knex = db): Promise<number> {
  const result = await conn
    .select(conn.raw("EXTRACT(EPOCH FROM now() - min(run_after)) AS age") as unknown as string)
    .from(TABLE)
    .where("status", "pending")
    .andWhere("run_after", "<=", conn.raw("now()"))
    .first<{ age: string | number | null } | undefined>();

  const age = result?.age;
  return age === null || age === undefined ? 0 : Math.max(0, Number(age));
}

/** Worker purge, one bounded batch per call (spec §5.6). */
export async function deleteFinishedBatch(
  status: FinishedStatus,
  olderThanDays: number,
  limit: number,
  conn: Knex,
): Promise<number> {
  const victims = conn
    .select("id")
    .from(TABLE)
    .where("status", status)
    .andWhere("completed_at", "<", conn.raw("now() - make_interval(days => ?)", [olderThanDays]))
    .limit(limit);

  return conn(TABLE).whereIn("id", victims).del();
}
