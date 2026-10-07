import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import type { AccountStatus, Role } from "../../../lib/rbac/types";
import { User } from "../entity/user.entity";
import type {
  NewUserRow,
  UpdateProfileInput,
  UserListCursor,
  UserListFilter,
  UserListItem,
  UserListRow,
  UserRow,
} from "../types";

/**
 * The single reader and writer of `users` (spec §1.4): the `users` module and Epic B go through
 * `AccountService`, so there is exactly one column list and one row mapper for this table.
 * Every read filters `deleted_at IS NULL` — this module has no `IncludingDeleted` function.
 */
const TABLE = "users";

export const USER_COLUMNS = [
  "id",
  "email",
  "phone",
  "password_hash",
  "full_name",
  "avatar_url",
  "role",
  "status",
  "email_verified_at",
  "timezone",
  "locale",
  "created_at",
  "updated_at",
  "deleted_at",
] as const;

function toEntity(row: UserRow): User {
  return new User({
    id: Number(row.id),
    email: row.email,
    phone: row.phone,
    passwordHash: row.password_hash,
    fullName: row.full_name,
    avatarUrl: row.avatar_url,
    role: row.role as Role,
    status: row.status as AccountStatus,
    emailVerifiedAt: row.email_verified_at,
    timezone: row.timezone,
    locale: row.locale,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  });
}

/** Login, register/start, register/complete, forgot-password, reset-password. Index: `uq_users_email`. */
export async function findLiveByEmail(email: string, conn: Knex = db): Promise<User | undefined> {
  const row = await conn(TABLE)
    .select([...USER_COLUMNS])
    .where("email", email)
    .whereNull("deleted_at")
    .first<UserRow | undefined>();

  return row === undefined ? undefined : toEntity(row);
}

/** getMe, updateMe, change-password, the refresh user re-read. Index: primary key. */
export async function findLiveById(id: number, conn: Knex = db): Promise<User | undefined> {
  const row = await conn(TABLE)
    .select([...USER_COLUMNS])
    .where("id", id)
    .whereNull("deleted_at")
    .first<UserRow | undefined>();

  return row === undefined ? undefined : toEntity(row);
}

/**
 * Login and password change lock the row so a concurrent reset or suspension either finishes first
 * (the caller sees the new hash or status) or waits until the transaction completes.
 * Index: primary key.
 */
export async function findLiveByIdForUpdate(id: number, conn: Knex): Promise<User | undefined> {
  const row = await conn(TABLE)
    .select([...USER_COLUMNS])
    .where("id", id)
    .whereNull("deleted_at")
    .forUpdate()
    .first<UserRow | undefined>();

  return row === undefined ? undefined : toEntity(row);
}

/**
 * The refresh rotation locks the user `FOR SHARE` before the token row (ADR 0019 / ADR 0020): it coexists
 * with other rotations of the same user but conflicts with every `FOR UPDATE` and row update, so it is
 * serialised against suspension, admin revoke, logout, reset and change-password. Index: primary key.
 */
export async function findLiveByIdForShare(id: number, conn: Knex): Promise<User | undefined> {
  const row = await conn(TABLE)
    .select([...USER_COLUMNS])
    .where("id", id)
    .whereNull("deleted_at")
    .forShare()
    .first<UserRow | undefined>();

  return row === undefined ? undefined : toEntity(row);
}

/**
 * `GET /api/users`: keyset page, newest first, optional whitelisted filters. Fetches `limit + 1` rows.
 * The cursor value is the microsecond text of `created_at`: a JS `Date` would truncate to milliseconds and
 * skip or repeat rows that share one. Indexes: `idx_users_created_at_id`, `idx_users_role_created_at_id`,
 * `idx_users_status_created_at_id`, `uq_users_email`.
 */
export async function listLive(
  filter: UserListFilter,
  cursor: UserListCursor | undefined,
  limit: number,
  conn: Knex = db,
): Promise<UserListItem[]> {
  const query = conn(TABLE)
    .select([
      ...USER_COLUMNS,
      conn.raw(
        `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor`,
      ),
    ])
    .whereNull("deleted_at");

  if (filter.role !== undefined) {
    query.where("role", filter.role);
  }
  if (filter.status !== undefined) {
    query.where("status", filter.status);
  }
  if (filter.email !== undefined) {
    query.where("email", filter.email);
  }
  if (cursor !== undefined) {
    query.whereRaw("(created_at, id) < (?::timestamptz, ?::bigint)", [cursor.createdAt, cursor.id]);
  }

  const rows = (await query
    .orderBy([
      { column: "created_at", order: "desc" },
      { column: "id", order: "desc" },
    ])
    .limit(limit + 1)) as UserListRow[];

  return rows.map((row) => ({ user: toEntity(row), createdAtCursor: row.created_at_cursor }));
}

/**
 * Admin status change: the caller holds the row lock. Returns `undefined` when the account was soft-deleted
 * meanwhile. `updated_at` moves only here, on a real change. Index: primary key.
 */
export async function updateStatus(
  id: number,
  status: AccountStatus,
  conn: Knex,
): Promise<User | undefined> {
  const rows = await conn(TABLE)
    .where("id", id)
    .whereNull("deleted_at")
    .update({ status, updated_at: conn.raw("now()") })
    .returning([...USER_COLUMNS]);

  const updated = (rows as UserRow[])[0];
  return updated === undefined ? undefined : toEntity(updated);
}

/** `email_verified_at` is set here: ownership was proven before the account existed (ADR 0006). */
export async function insertUser(row: NewUserRow, conn: Knex = db): Promise<User> {
  const inserted = await conn(TABLE)
    .insert({
      email: row.email,
      phone: row.phone,
      password_hash: row.passwordHash,
      full_name: row.fullName,
      avatar_url: null,
      role: row.role,
      status: row.status,
      email_verified_at: conn.raw("now()"),
      timezone: row.timezone,
      locale: row.locale,
    })
    .returning([...USER_COLUMNS]);

  const created = (inserted as UserRow[])[0];
  if (created === undefined) {
    throw new Error("user_insert_returned_no_row");
  }
  return toEntity(created);
}

/** Returns the number of affected rows: 0 means the account was soft-deleted meanwhile. */
export async function updatePasswordHash(
  id: number,
  passwordHash: string,
  conn: Knex = db,
): Promise<number> {
  return conn(TABLE)
    .where("id", id)
    .whereNull("deleted_at")
    .update({ password_hash: passwordHash, updated_at: conn.raw("now()") });
}

/**
 * `PATCH /me`: only the five whitelisted columns, and only while the account is live and not suspended —
 * so a still-valid access token cannot update a row that has since been suspended (BR-24).
 * No row returned → the caller re-reads to tell "suspended" from "gone".
 */
export async function updateProfileUnlessSuspended(
  id: number,
  patch: UpdateProfileInput,
  conn: Knex = db,
): Promise<User | undefined> {
  const columns: Record<string, string | null | Knex.Raw> = { updated_at: conn.raw("now()") };
  if (patch.fullName !== undefined) {
    columns.full_name = patch.fullName;
  }
  if (patch.phone !== undefined) {
    columns.phone = patch.phone;
  }
  if (patch.avatarUrl !== undefined) {
    columns.avatar_url = patch.avatarUrl;
  }
  if (patch.timezone !== undefined) {
    columns.timezone = patch.timezone;
  }
  if (patch.locale !== undefined) {
    columns.locale = patch.locale;
  }

  const rows = await conn(TABLE)
    .where("id", id)
    .whereNull("deleted_at")
    .whereNot("status", "suspended")
    .update(columns)
    .returning([...USER_COLUMNS]);

  const updated = (rows as UserRow[])[0];
  return updated === undefined ? undefined : toEntity(updated);
}
