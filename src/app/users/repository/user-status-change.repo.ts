import type { Knex } from "knex";
import type { NewStatusChange } from "../types";

/**
 * Insert-only by design (BR-17): history is never updated or deleted, so this module exposes no such
 * function. Reads are by ops SQL and a future admin route, through the two indexes of the table migration.
 */
const TABLE = "user_status_changes";

/** Runs inside the status-change transaction, after the `users` update. Returns the new row id. */
export async function insertStatusChange(row: NewStatusChange, trx: Knex.Transaction): Promise<number> {
  const inserted = await trx(TABLE)
    .insert({
      user_id: row.userId,
      from_status: row.fromStatus,
      to_status: row.toStatus,
      actor_user_id: row.actorUserId,
      actor_service: row.actorService,
      reason: row.reason,
      request_id: row.requestId,
    })
    .returning("id");

  const created = (inserted as { id: string | number }[])[0];
  if (created === undefined) {
    throw new Error("user_status_change_insert_returned_no_row");
  }
  return Number(created.id);
}
