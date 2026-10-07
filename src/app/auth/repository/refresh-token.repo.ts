import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import { RefreshToken } from "../entity/refresh-token.entity";
import type { RevokedReason } from "../enums";
import type {
  LiveFamily,
  LiveFamilyCursor,
  LiveFamilyRow,
  NewRefreshTokenRow,
  RefreshTokenRow,
} from "../types";

/** Owned by `auth`; revocation is exposed to other modules through `SessionService` (spec §1.4). */
const TABLE = "refresh_tokens";

export const REFRESH_TOKEN_COLUMNS = [
  "id",
  "user_id",
  "family_id",
  "token_hash",
  "expires_at",
  "revoked_at",
  "revoked_reason",
  "replaced_by_id",
  "device_info",
  "created_at",
] as const;

function toEntity(row: RefreshTokenRow): RefreshToken {
  return new RefreshToken({
    id: Number(row.id),
    userId: Number(row.user_id),
    familyId: row.family_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason as RevokedReason | null,
    replacedById: row.replaced_by_id === null ? null : Number(row.replaced_by_id),
    deviceInfo: row.device_info,
    createdAt: row.created_at,
  });
}

/**
 * Refresh, logout and change-password cookie lookup. **No revocation filter**: reuse detection needs to see
 * an already-rotated row (BR-12). Index: `uq_refresh_tokens_token_hash`.
 */
export async function findByTokenHash(
  tokenHash: string,
  conn: Knex = db,
): Promise<RefreshToken | undefined> {
  const row = await conn(TABLE)
    .select([...REFRESH_TOKEN_COLUMNS])
    .where("token_hash", tokenHash)
    .first<RefreshTokenRow | undefined>();

  return row === undefined ? undefined : toEntity(row);
}

export async function findById(id: number, conn: Knex = db): Promise<RefreshToken | undefined> {
  const row = await conn(TABLE)
    .select([...REFRESH_TOKEN_COLUMNS])
    .where("id", id)
    .first<RefreshTokenRow | undefined>();

  return row === undefined ? undefined : toEntity(row);
}

/** Locks the presented row for the rotation transaction (spec §4.4 step 6a). */
export async function findByIdForUpdate(
  id: number,
  trx: Knex.Transaction,
): Promise<RefreshToken | undefined> {
  const row = await trx(TABLE)
    .select([...REFRESH_TOKEN_COLUMNS])
    .where("id", id)
    .forUpdate()
    .first<RefreshTokenRow | undefined>();

  return row === undefined ? undefined : toEntity(row);
}

export async function insertToken(row: NewRefreshTokenRow, conn: Knex = db): Promise<number> {
  const inserted = await conn(TABLE)
    .insert({
      user_id: row.userId,
      family_id: row.familyId,
      token_hash: row.tokenHash,
      expires_at: row.expiresAt,
      device_info: row.deviceInfo,
    })
    .returning("id");

  const created = (inserted as { id: string | number }[])[0];
  if (created === undefined) {
    throw new Error("refresh_token_insert_returned_no_row");
  }
  return Number(created.id);
}

/** Rotation (BR-11): must affect exactly one row, else the caller rolls back. */
export async function markRotated(
  id: number,
  replacedById: number,
  trx: Knex.Transaction,
): Promise<number> {
  return trx(TABLE).where("id", id).whereNull("revoked_at").update({
    revoked_at: trx.raw("now()"),
    revoked_reason: "rotated",
    replaced_by_id: replacedById,
  });
}

/** Logout, reuse detection, suspended refresh. Index: `idx_refresh_tokens_family_id_live`. */
export async function revokeFamily(
  familyId: string,
  reason: RevokedReason,
  conn: Knex = db,
): Promise<number> {
  return conn(TABLE)
    .where("family_id", familyId)
    .whereNull("revoked_at")
    .update({ revoked_at: conn.raw("now()"), revoked_reason: reason });
}

/**
 * Password reset and change-password here; suspension and admin revoke in the `users` module, always inside
 * the caller's transaction. Index: `idx_refresh_tokens_user_id_created_at`.
 */
export async function revokeAllForUser(
  userId: number,
  reason: RevokedReason,
  conn: Knex = db,
  exceptFamilyId?: string,
): Promise<number> {
  const query = conn(TABLE).where("user_id", userId).whereNull("revoked_at");
  if (exceptFamilyId !== undefined) {
    query.whereNot("family_id", exceptFamilyId);
  }
  return query.update({ revoked_at: conn.raw("now()"), revoked_reason: reason });
}

/** Worker purge, 30 days past expiry. Index: `idx_refresh_tokens_expires_at`. */
export async function deleteExpiredBatch(limit: number, trx: Knex.Transaction): Promise<number> {
  const victims = trx
    .select("id")
    .from(TABLE)
    .where("expires_at", "<", trx.raw("now() - interval '30 days'"))
    .limit(limit);

  return trx(TABLE).whereIn("id", victims).del();
}

/**
 * `GET /api/users/:id/sessions`: one row per live family (a token not revoked and not expired), joined to the
 * family's earliest retained token for `createdAt`. Sorted `first_created_at DESC, family_id ASC`; the set is
 * bounded by the user's live logins, so sorting after the index scan is acceptable. Fetches `limit + 1`.
 * Indexes: `idx_refresh_tokens_user_id_live`, `idx_refresh_tokens_family_id_created_at`.
 */
export async function listLiveFamilies(
  userId: number,
  now: Date,
  cursor: LiveFamilyCursor | undefined,
  limit: number,
  conn: Knex = db,
): Promise<LiveFamily[]> {
  const bindings: (string | number | Date)[] = [userId, now];
  let keyset = "";
  if (cursor !== undefined) {
    keyset =
      "WHERE (f.first_created_at < ?::timestamptz OR (f.first_created_at = ?::timestamptz AND l.family_id > ?::uuid))";
    bindings.push(cursor.createdAt, cursor.createdAt, cursor.familyId);
  }
  bindings.push(limit + 1);

  const result = await conn.raw<{ rows: LiveFamilyRow[] }>(
    `SELECT l.family_id, l.device_info, l.last_used_at, l.expires_at, f.first_created_at,
            to_char(f.first_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS first_created_at_cursor
       FROM (
              SELECT DISTINCT ON (family_id) family_id, device_info, created_at AS last_used_at, expires_at
                FROM refresh_tokens
               WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
               ORDER BY family_id, created_at DESC, id DESC
            ) l
      CROSS JOIN LATERAL (
              SELECT r.created_at AS first_created_at
                FROM refresh_tokens r
               WHERE r.family_id = l.family_id
               ORDER BY r.created_at, r.id
               LIMIT 1
            ) f
      ${keyset}
      ORDER BY f.first_created_at DESC, l.family_id ASC
      LIMIT ?`,
    bindings,
  );

  return result.rows.map((row) => ({
    familyId: row.family_id,
    deviceInfo: row.device_info,
    createdAt: row.first_created_at,
    createdAtCursor: row.first_created_at_cursor,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
  }));
}
