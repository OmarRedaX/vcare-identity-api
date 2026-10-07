import type { Knex } from "knex";

/**
 * user_status_changes: append-only history of every `users.status` change (CLAUDE.md -> Database rules,
 * Status history; docs/architecture/data-model.md). Never updated, never purged, so no `updated_at` and no
 * `deleted_at`. No default on the status columns: the service always sets them explicitly.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
      CREATE TABLE user_status_changes (
          id            BIGSERIAL PRIMARY KEY,
          user_id       BIGINT       NOT NULL,
          from_status   VARCHAR(16)  NOT NULL,
          to_status     VARCHAR(16)  NOT NULL,
          actor_user_id BIGINT       NULL,
          actor_service VARCHAR(64)  NULL,
          reason        VARCHAR(500) NOT NULL,
          request_id    UUID         NOT NULL,
          created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

          CONSTRAINT fk_user_status_changes_user_id
              FOREIGN KEY (user_id) REFERENCES users (id),
          CONSTRAINT fk_user_status_changes_actor_user_id
              FOREIGN KEY (actor_user_id) REFERENCES users (id),
          CONSTRAINT chk_user_status_changes_from_status
              CHECK (from_status IN ('pending', 'active', 'suspended', 'rejected')),
          CONSTRAINT chk_user_status_changes_to_status
              CHECK (to_status IN ('pending', 'active', 'suspended', 'rejected')),
          CONSTRAINT chk_user_status_changes_differs CHECK (from_status <> to_status),
          CONSTRAINT chk_user_status_changes_actor
              CHECK (actor_user_id IS NOT NULL OR actor_service IS NOT NULL),
          CONSTRAINT chk_user_status_changes_reason_not_blank CHECK (length(btrim(reason)) > 0)
      );
  `);

  // Status history of one user (support investigation, ops SQL, a future admin route):
  //   SELECT ... FROM user_status_changes WHERE user_id = $1 ORDER BY created_at DESC
  // Covers fk_user_status_changes_user_id.
  await knex.raw(`
      CREATE INDEX idx_user_status_changes_user_id_created_at
          ON user_status_changes (user_id, created_at DESC);
  `);

  // "What did this admin change" audit:
  //   SELECT ... FROM user_status_changes WHERE actor_user_id = $1
  // Covers fk_user_status_changes_actor_user_id; service-initiated rows have no actor user.
  await knex.raw(`
      CREATE INDEX idx_user_status_changes_actor_user_id
          ON user_status_changes (actor_user_id) WHERE actor_user_id IS NOT NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS user_status_changes;`);
}
