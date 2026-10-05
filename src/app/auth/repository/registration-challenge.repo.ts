import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import { RegistrationChallenge } from "../entity/registration-challenge.entity";
import type { RegistrationChallengeRow } from "../types";

/** Email ownership proof before the account exists (ADR 0006); no FK to `users`. */
const TABLE = "registration_challenges";

export const REGISTRATION_CHALLENGE_COLUMNS = [
  "id",
  "email",
  "code_hash",
  "attempts",
  "expires_at",
  "consumed_at",
  "invalidated_at",
  "created_at",
] as const;

function toEntity(row: RegistrationChallengeRow): RegistrationChallenge {
  return new RegistrationChallenge({
    id: Number(row.id),
    email: row.email,
    codeHash: row.code_hash,
    attempts: Number(row.attempts),
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    invalidatedAt: row.invalidated_at,
    createdAt: row.created_at,
  });
}

/**
 * Serialises concurrent `register/start` calls for one email for the rest of the transaction, so the
 * invalidate-then-insert pair can never interleave and leave two open challenges (BR-1). The lock is released
 * on commit or rollback; it needs no schema change.
 */
export async function lockEmailForStart(email: string, conn: Knex = db): Promise<void> {
  await conn.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [email.toLowerCase()]);
}

/** register/start: a resend supersedes earlier open challenges (BR-1). */
export async function invalidateOpenForEmail(email: string, conn: Knex = db): Promise<number> {
  return conn(TABLE)
    .where("email", email)
    .whereNull("consumed_at")
    .whereNull("invalidated_at")
    .update({ invalidated_at: conn.raw("now()") });
}

/** `attempts` has no column default; it is set explicitly. */
export async function insertChallenge(email: string, conn: Knex = db): Promise<number> {
  const inserted = await conn(TABLE).insert({ email, attempts: 0 }).returning("id");
  const created = (inserted as { id: string | number }[])[0];
  if (created === undefined) {
    throw new Error("registration_challenge_insert_returned_no_row");
  }
  return Number(created.id);
}

/** register/complete: the only challenge a code may match, locked for the transaction (BR-3). */
export async function findLatestOpenForUpdate(
  email: string,
  trx: Knex.Transaction,
): Promise<RegistrationChallenge | undefined> {
  const row = await trx(TABLE)
    .select([...REGISTRATION_CHALLENGE_COLUMNS])
    .where("email", email)
    .whereNull("consumed_at")
    .whereNull("invalidated_at")
    .orderBy("created_at", "desc")
    .limit(1)
    .forUpdate()
    .first<RegistrationChallengeRow | undefined>();

  return row === undefined ? undefined : toEntity(row);
}

/** Worker: load the aggregate of a `send_registration_code` job. */
export async function findByIdForUpdate(
  id: number,
  trx: Knex.Transaction,
): Promise<RegistrationChallenge | undefined> {
  const row = await trx(TABLE)
    .select([...REGISTRATION_CHALLENGE_COLUMNS])
    .where("id", id)
    .forUpdate()
    .first<RegistrationChallengeRow | undefined>();

  return row === undefined ? undefined : toEntity(row);
}

/**
 * Worker, at send time: stores `HMAC-SHA256(OTP_PEPPER, code)` and starts the 10-minute window (BR-2).
 * Overwrites a code from an earlier delivery attempt; `attempts` is unchanged.
 */
export async function markSent(
  id: number,
  codeHash: string,
  trx: Knex.Transaction,
): Promise<number> {
  return trx(TABLE)
    .where("id", id)
    .update({ code_hash: codeHash, expires_at: trx.raw("now() + interval '10 minutes'") });
}

/** The 5th failure invalidates the challenge (BR-3). */
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

export async function markConsumed(id: number, trx: Knex.Transaction): Promise<number> {
  return trx(TABLE)
    .where("id", id)
    .whereNull("consumed_at")
    .whereNull("invalidated_at")
    .update({ attempts: trx.raw("attempts + 1"), consumed_at: trx.raw("now()") });
}

/** Worker purge, 24 h after creation. Index: `idx_registration_challenges_created_at`. */
export async function deleteOldBatch(limit: number, trx: Knex.Transaction): Promise<number> {
  const victims = trx
    .select("id")
    .from(TABLE)
    .where("created_at", "<", trx.raw("now() - interval '24 hours'"))
    .limit(limit);

  return trx(TABLE).whereIn("id", victims).del();
}
