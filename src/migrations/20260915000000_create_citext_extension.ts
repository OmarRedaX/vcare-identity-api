import type { Knex } from "knex";

/**
 * citext extension — required by `users.email CITEXT` (CLAUDE.md -> Database rules).
 * Raw SQL only; this migration creates no table.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
      CREATE EXTENSION IF NOT EXISTS citext;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
      DROP EXTENSION IF EXISTS citext;
  `);
}
