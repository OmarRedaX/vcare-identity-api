import type { Knex } from "knex";

/**
 * service_clients: registered callers of `/internal/*` (CLAUDE.md -> Authentication and service-to-service
 * auth; docs/service-auth/spec.md section 2). Rows are created, rotated and disabled by ops SQL only
 * (`scripts/provision-service-client.ts` prints it); application code reads and touches `last_used_at`.
 *
 * Secrets: both hashes are argon2id (CHECK), never plaintext. `is_active` has no default: the provisioning
 * SQL always sets it explicitly. `allowed_scopes` must stay equal to `SERVICE_SCOPES` in
 * `lib/auth/constants.ts` (a unit test asserts it). No FK in or out: `user_status_changes.actor_service`
 * references `client_id` logically, by design.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
      CREATE TABLE service_clients (
          id                         BIGSERIAL PRIMARY KEY,
          client_id                  VARCHAR(64)  NOT NULL,
          name                       VARCHAR(120) NOT NULL,
          client_secret_hash         VARCHAR(255) NOT NULL,
          previous_secret_hash       VARCHAR(255) NULL,
          previous_secret_expires_at TIMESTAMPTZ  NULL,
          allowed_scopes             TEXT[]       NOT NULL,
          allowed_audiences          TEXT[]       NOT NULL,
          is_active                  BOOLEAN      NOT NULL,
          secret_rotated_at          TIMESTAMPTZ  NULL,
          last_used_at               TIMESTAMPTZ  NULL,
          created_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
          deleted_at                 TIMESTAMPTZ  NULL,

          CONSTRAINT chk_service_clients_client_id
              CHECK (client_id ~ '^[a-z][a-z0-9-]{2,63}$'),
          CONSTRAINT chk_service_clients_name_not_blank
              CHECK (length(btrim(name)) > 0),
          CONSTRAINT chk_service_clients_secret_hash_argon2id
              CHECK (client_secret_hash LIKE '$argon2id$%'),
          CONSTRAINT chk_service_clients_previous_hash_argon2id
              CHECK (previous_secret_hash IS NULL OR previous_secret_hash LIKE '$argon2id$%'),
          CONSTRAINT chk_service_clients_previous_secret_pair
              CHECK ((previous_secret_hash IS NULL) = (previous_secret_expires_at IS NULL)),
          CONSTRAINT chk_service_clients_allowed_scopes
              CHECK (allowed_scopes <@ ARRAY['users:read', 'users:status:write', 'doctors:read']::text[]),
          CONSTRAINT chk_service_clients_allowed_scopes_nonempty
              CHECK (cardinality(allowed_scopes) >= 1),
          CONSTRAINT chk_service_clients_allowed_audiences_shape
              CHECK (allowed_audiences::text ~ '^\\{vcare-[a-z0-9-]+(,vcare-[a-z0-9-]+)*\\}$')
      );
  `);

  // Token endpoint lookup, the only read of this table:
  //   SELECT <SERVICE_CLIENT_COLUMNS> FROM service_clients WHERE client_id = $1 AND deleted_at IS NULL
  // Partial, so a soft-deleted client_id can be registered again.
  await knex.raw(`
      CREATE UNIQUE INDEX uq_service_clients_client_id
          ON service_clients (client_id) WHERE deleted_at IS NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS service_clients;`);
}
