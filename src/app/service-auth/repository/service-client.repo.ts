import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import { ServiceClient } from "../entity/service-client.entity";
import type { ServiceClientRow } from "../types";

/**
 * Read and touch only (BR-21): clients are created, rotated, disabled and deleted by ops SQL, so this module
 * has no insert, update-secret or delete function. Every read filters `deleted_at IS NULL`.
 */
const TABLE = "service_clients";

export const SERVICE_CLIENT_COLUMNS = [
  "id",
  "client_id",
  "name",
  "client_secret_hash",
  "previous_secret_hash",
  "previous_secret_expires_at",
  "allowed_scopes",
  "allowed_audiences",
  "is_active",
  "secret_rotated_at",
  "last_used_at",
  "created_at",
  "updated_at",
  "deleted_at",
] as const;

function toEntity(row: ServiceClientRow): ServiceClient {
  return new ServiceClient({
    id: Number(row.id),
    clientId: row.client_id,
    name: row.name,
    clientSecretHash: row.client_secret_hash,
    previousSecretHash: row.previous_secret_hash,
    previousSecretExpiresAt: row.previous_secret_expires_at,
    allowedScopes: row.allowed_scopes,
    allowedAudiences: row.allowed_audiences,
    isActive: row.is_active,
    secretRotatedAt: row.secret_rotated_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  });
}

/** Token endpoint. Index: `uq_service_clients_client_id`. */
export async function findLiveByClientId(
  clientId: string,
  conn: Knex = db,
): Promise<ServiceClient | undefined> {
  const row = await conn(TABLE)
    .select([...SERVICE_CLIENT_COLUMNS])
    .where("client_id", clientId)
    .whereNull("deleted_at")
    .first<ServiceClientRow | undefined>();

  return row === undefined ? undefined : toEntity(row);
}

/**
 * Advances `last_used_at` at most once per minute (BR-20). Primary-key update; `updated_at` is not touched
 * because usage is not a modification.
 */
export async function touchLastUsed(id: number, now: Date, conn: Knex = db): Promise<void> {
  await conn(TABLE)
    .where("id", id)
    .whereNull("deleted_at")
    .andWhere((builder) => {
      builder
        .whereNull("last_used_at")
        .orWhereRaw("last_used_at < ?::timestamptz - interval '1 minute'", [now]);
    })
    .update({ last_used_at: now });
}
