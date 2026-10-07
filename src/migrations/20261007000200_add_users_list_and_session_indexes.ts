import type { Knex } from "knex";

/**
 * Additive indexes on tables owned by `auth`, for the `users` module's admin list and session list
 * (docs/users/spec.md section 2.2). Each index is named for the query it serves.
 */
export async function up(knex: Knex): Promise<void> {
  // GET /api/users default page (no filter):
  //   WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT $n
  await knex.raw(`
      CREATE INDEX idx_users_created_at_id ON users (created_at DESC, id DESC) WHERE deleted_at IS NULL;
  `);

  // GET /api/users?role=:
  //   WHERE deleted_at IS NULL AND role = $1 ORDER BY created_at DESC, id DESC
  await knex.raw(`
      CREATE INDEX idx_users_role_created_at_id
          ON users (role, created_at DESC, id DESC) WHERE deleted_at IS NULL;
  `);

  // GET /api/users?status=:
  //   WHERE deleted_at IS NULL AND status = $1 ORDER BY created_at DESC, id DESC
  await knex.raw(`
      CREATE INDEX idx_users_status_created_at_id
          ON users (status, created_at DESC, id DESC) WHERE deleted_at IS NULL;
  `);

  // GET /api/users/:id/sessions, live tokens of one user:
  //   WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2
  await knex.raw(`
      CREATE INDEX idx_refresh_tokens_user_id_live ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
  `);

  // Session createdAt, the earliest retained token of a family:
  //   WHERE family_id = $1 ORDER BY created_at, id LIMIT 1
  await knex.raw(`
      CREATE INDEX idx_refresh_tokens_family_id_created_at ON refresh_tokens (family_id, created_at, id);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS idx_refresh_tokens_family_id_created_at;`);
  await knex.raw(`DROP INDEX IF EXISTS idx_refresh_tokens_user_id_live;`);
  await knex.raw(`DROP INDEX IF EXISTS idx_users_status_created_at_id;`);
  await knex.raw(`DROP INDEX IF EXISTS idx_users_role_created_at_id;`);
  await knex.raw(`DROP INDEX IF EXISTS idx_users_created_at_id;`);
}
