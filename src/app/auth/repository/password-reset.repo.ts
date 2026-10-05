import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import { PasswordReset } from "../entity/password-reset.entity";
import type { PasswordResetRow } from "../types";

/** One row per forgot-password request; the code itself only ever exists as an HMAC here (ADR 0017). */
const TABLE = "password_resets";

export const PASSWORD_RESET_COLUMNS = [
  "id",
  "user_id",
  "code_hash",
  "attempts",
  "expires_at",
  "used_at",
  "invalidated_at",
  "created_at",
] as const;

function toEntity(row: PasswordResetRow): PasswordReset {
  return new PasswordReset({
    id: Number(row.id),
    userId: Number(row.user_id),
    codeHash: row.code_hash,
    attempts: Number(row.attempts),
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    invalidatedAt: row.invalidated_at,
    createdAt: row.created_at,
  });
}

/** A newer request supersedes earlier open rows (BR-19). Index: `idx_password_resets_user_id_created_at`. */
export async function invalidateOpenForUser(userId: number, conn: Knex = db): Promise<number> {
  return conn(TABLE)
    .where("user_id", userId)
    .whereNull("used_at")
    .whereNull("invalidated_at")
    .update({ invalidated_at: conn.raw("now()") });
}

/** `attempts` has no column default; it is set explicitly, exactly as for registration challenges. */
export async function insertReset(userId: number, conn: Knex = db): Promise<number> {
  const inserted = await conn(TABLE).insert({ user_id: userId, attempts: 0 }).returning("id");
  const created = (inserted as { id: string | number }[])[0];
  if (created === undefined) {
    throw new Error("password_reset_insert_returned_no_row");
  }
  return Number(created.id);
}

/** reset-password: the only row a code may match, locked for the transaction (BR-20). */
export async function findLatestOpenForUpdate(
  userId: number,
  trx: Knex.Transaction,
): Promise<PasswordReset | undefined> {
  const row = await trx(TABLE)
    .select([...PASSWORD_RESET_COLUMNS])
    .where("user_id", userId)
    .whereNull("used_at")
    .whereNull("invalidated_at")
    .orderBy("created_at", "desc")
    .limit(1)
    .forUpdate()
    .first<PasswordResetRow | undefined>();

  return row === undefined ? undefined : toEntity(row);
}

/** Worker: load the aggregate of a `send_password_reset` job. */
export async function findByIdForUpdate(
  id: number,
  trx: Knex.Transaction,
): Promise<PasswordReset | undefined> {
  const row = await trx(TABLE)
    .select([...PASSWORD_RESET_COLUMNS])
    .where("id", id)
    .forUpdate()
    .first<PasswordResetRow | undefined>();

  return row === undefined ? undefined : toEntity(row);
}

/**
 * Worker, at send time: stores `HMAC-SHA256(OTP_PEPPER, code)` and starts the 30-minute window.
 * Overwrites a code from an earlier delivery attempt (at-least-once, ADR 0007); `attempts` is unchanged.
 */
export async function markSent(
  id: number,
  codeHash: string,
  trx: Knex.Transaction,
): Promise<number> {
  return trx(TABLE)
    .where("id", id)
    .update({ code_hash: codeHash, expires_at: trx.raw("now() + interval '30 minutes'") });
}

/** The 5th failure invalidates the row (BR-19), so the counter is authoritative. */
export async function recordFailedAttempt(
  id: number,
  exhausted: boolean,
  trx: Knex.Transaction,
): Promise<number> {
  return trx(TABLE)
    .where("id", id)
    .update({
      attempts: trx.raw("attempts + 1"),
      invalidated_at: exhausted ? trx.raw("now()") : null,
    });
}

/** Guarded so a concurrent use cannot consume the row twice; must affect exactly one row. */
export async function markUsed(id: number, trx: Knex.Transaction): Promise<number> {
  return trx(TABLE)
    .where("id", id)
    .whereNull("used_at")
    .whereNull("invalidated_at")
    .where("expires_at", ">", trx.raw("now()"))
    .update({ attempts: trx.raw("attempts + 1"), used_at: trx.raw("now()") });
}

/** Worker purge, 30 days after creation. Index: `idx_password_resets_created_at`. */
export async function deleteOldBatch(limit: number, trx: Knex.Transaction): Promise<number> {
  const victims = trx
    .select("id")
    .from(TABLE)
    .where("created_at", "<", trx.raw("now() - interval '30 days'"))
    .limit(limit);

  return trx(TABLE).whereIn("id", victims).del();
}
