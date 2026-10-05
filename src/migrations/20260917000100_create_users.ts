import type { Knex } from "knex";

/**
 * users: the accounts Identity is the single writer for (CLAUDE.md -> Mission of this service).
 * The only business table of the auth module: soft delete only, email unique among live rows.
 * No default on `role`/`status` — the service always sets them explicitly (CLAUDE.md -> Database rules).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
      CREATE TABLE users (
          id                BIGSERIAL PRIMARY KEY,
          email             CITEXT        NOT NULL,
          phone             VARCHAR(16)   NULL,
          password_hash     VARCHAR(255)  NOT NULL,
          full_name         VARCHAR(120)  NOT NULL,
          avatar_url        VARCHAR(2048) NULL,
          role              VARCHAR(16)   NOT NULL,
          status            VARCHAR(16)   NOT NULL,
          email_verified_at TIMESTAMPTZ   NULL,
          timezone          VARCHAR(64)   NOT NULL,
          locale            VARCHAR(35)   NOT NULL,
          created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
          updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
          deleted_at        TIMESTAMPTZ   NULL,

          CONSTRAINT chk_users_role   CHECK (role IN ('patient', 'doctor', 'admin')),
          CONSTRAINT chk_users_status CHECK (status IN ('pending', 'active', 'suspended', 'rejected')),
          CONSTRAINT chk_users_phone_e164 CHECK (phone IS NULL OR phone ~ '^\\+[1-9][0-9]{7,14}$'),
          CONSTRAINT chk_users_full_name_not_blank CHECK (length(btrim(full_name)) > 0),
          CONSTRAINT chk_users_email_length CHECK (length(email) <= 254)
      );
  `);

  // login, register/start, register/complete, forgot-password, reset-password:
  //   SELECT <USER_COLUMNS> FROM users WHERE email = $1 AND deleted_at IS NULL
  // Partial so a soft-deleted account frees its email for re-registration (domain rule 9).
  await knex.raw(`
      CREATE UNIQUE INDEX uq_users_email ON users (email) WHERE deleted_at IS NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS users;`);
}
