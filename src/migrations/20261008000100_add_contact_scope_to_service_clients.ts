import type { Knex } from "knex";

/**
 * Adds the `users:contact:read` scope (ADR 0024, hub ADR 0010) to the service-client vocabulary and makes it
 * grantable to `care-service` only, in the database, so neither a forgotten code path nor hand-written ops SQL
 * can give another client the scope that exposes email addresses.
 *
 * `allowed_scopes` must stay equal to `SERVICE_SCOPES` in `lib/auth/constants.ts` (a unit test asserts it).
 * Constraint changes only: no index (the table is read by `client_id`), no data change on `up`.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
      ALTER TABLE service_clients
          DROP CONSTRAINT chk_service_clients_allowed_scopes;
  `);
  await knex.raw(`
      ALTER TABLE service_clients
          ADD CONSTRAINT chk_service_clients_allowed_scopes
              CHECK (allowed_scopes <@ ARRAY['users:read', 'users:status:write', 'doctors:read', 'users:contact:read']::text[]);
  `);
  await knex.raw(`
      ALTER TABLE service_clients
          ADD CONSTRAINT chk_service_clients_contact_scope_care_only
              CHECK (NOT ('users:contact:read' = ANY (allowed_scopes)) OR client_id = 'care-service');
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
      ALTER TABLE service_clients
          DROP CONSTRAINT chk_service_clients_contact_scope_care_only;
  `);
  await knex.raw(`
      UPDATE service_clients
         SET allowed_scopes = array_remove(allowed_scopes, 'users:contact:read')
       WHERE 'users:contact:read' = ANY (allowed_scopes);
  `);
  await knex.raw(`
      ALTER TABLE service_clients
          DROP CONSTRAINT chk_service_clients_allowed_scopes;
  `);
  await knex.raw(`
      ALTER TABLE service_clients
          ADD CONSTRAINT chk_service_clients_allowed_scopes
              CHECK (allowed_scopes <@ ARRAY['users:read', 'users:status:write', 'doctors:read']::text[]);
  `);
}
