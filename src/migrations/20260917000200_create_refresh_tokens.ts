import type { Knex } from "knex";

/**
 * refresh_tokens: one row per issued refresh token; `family_id` groups a login's rotation chain
 * (CLAUDE.md -> Authentication and service-to-service auth; ADR 0002, ADR 0005).
 * A token table, not a business table: no `deleted_at`, purged by the worker 30 days after `expires_at`
 * (data-model.md -> Conventions). Only the sha256 of the 256-bit token is stored.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
      CREATE TABLE refresh_tokens (
          id             BIGSERIAL PRIMARY KEY,
          user_id        BIGINT       NOT NULL,
          family_id      UUID         NOT NULL,
          token_hash     CHAR(64)     NOT NULL,
          expires_at     TIMESTAMPTZ  NOT NULL,
          revoked_at     TIMESTAMPTZ  NULL,
          revoked_reason VARCHAR(32)  NULL,
          replaced_by_id BIGINT       NULL,
          device_info    VARCHAR(255) NULL,
          created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),

          CONSTRAINT fk_refresh_tokens_user_id
              FOREIGN KEY (user_id) REFERENCES users (id),
          CONSTRAINT fk_refresh_tokens_replaced_by_id
              FOREIGN KEY (replaced_by_id) REFERENCES refresh_tokens (id) ON DELETE SET NULL,
          CONSTRAINT chk_refresh_tokens_revoked_reason CHECK (
              revoked_reason IS NULL OR revoked_reason IN (
                  'rotated', 'reuse_detected', 'logout', 'password_changed',
                  'password_reset', 'status_changed', 'admin_revoked', 'account_deleted'
              )
          ),
          CONSTRAINT chk_refresh_tokens_revoked_pair CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
          CONSTRAINT chk_refresh_tokens_replaced_by_rotated CHECK (
              replaced_by_id IS NULL OR revoked_reason = 'rotated'
          ),
          CONSTRAINT chk_refresh_tokens_token_hash_hex CHECK (token_hash ~ '^[0-9a-f]{64}$'),
          CONSTRAINT chk_refresh_tokens_expiry CHECK (expires_at > created_at)
      );
  `);

  // refresh / logout / change-password cookie lookup: WHERE token_hash = $1
  // (includes revoked rows on purpose, so reuse of a rotated token is detectable).
  await knex.raw(`
      CREATE UNIQUE INDEX uq_refresh_tokens_token_hash ON refresh_tokens (token_hash);
  `);

  // Covers fk_refresh_tokens_user_id. Revoke-all for a user (password reset, change-password, and the users
  // module's suspension / admin revoke):
  //   UPDATE refresh_tokens SET ... WHERE user_id = $1 AND revoked_at IS NULL [AND family_id <> $2]
  // Also serves the users module's session list by user.
  await knex.raw(`
      CREATE INDEX idx_refresh_tokens_user_id_created_at ON refresh_tokens (user_id, created_at DESC);
  `);

  // Revoke one family (logout, reuse detection, refresh of a suspended account):
  //   UPDATE refresh_tokens SET ... WHERE family_id = $1 AND revoked_at IS NULL
  await knex.raw(`
      CREATE INDEX idx_refresh_tokens_family_id_live ON refresh_tokens (family_id) WHERE revoked_at IS NULL;
  `);

  // Covers fk_refresh_tokens_replaced_by_id (needed by ON DELETE SET NULL during a purge batch) and
  // enforces at most one successor per token (BR-11).
  await knex.raw(`
      CREATE UNIQUE INDEX uq_refresh_tokens_replaced_by_id ON refresh_tokens (replaced_by_id)
          WHERE replaced_by_id IS NOT NULL;
  `);

  // Worker purge: DELETE ... WHERE id IN
  //   (SELECT id FROM refresh_tokens WHERE expires_at < now() - interval '30 days' LIMIT $1)
  await knex.raw(`
      CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens (expires_at);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS refresh_tokens;`);
}
