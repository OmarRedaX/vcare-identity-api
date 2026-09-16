import path from "node:path";
import type { Knex } from "knex";
import type { KnexOptions } from "./types";

const ACQUIRE_TIMEOUT_MS = 1000;

/** Every pooled connection is UTC (CLAUDE.md -> Database rules). */
export function buildKnexConfig(options: KnexOptions): Knex.Config {
  return {
    client: "pg",
    connection: {
      connectionString: options.databaseUrl,
      ...(options.statementTimeoutMs === null ? {} : { statement_timeout: options.statementTimeoutMs }),
    },
    pool: {
      min: 0,
      max: options.poolMax,
      acquireTimeoutMillis: ACQUIRE_TIMEOUT_MS,
      afterCreate: (conn: { query: (sql: string, cb: (err: Error | null) => void) => void }, done: (err: Error | null, connection: unknown) => void) => {
        conn.query("SET TIME ZONE 'UTC'", (err: Error | null) => {
          done(err, conn);
        });
      },
    },
    acquireConnectionTimeout: ACQUIRE_TIMEOUT_MS,
  };
}

/** Migrations run without a statement timeout and on a tiny pool. */
export function migrationConfig(databaseUrl: string): Knex.Config {
  return {
    ...buildKnexConfig({ databaseUrl, poolMax: 2, statementTimeoutMs: null }),
    migrations: {
      directory: path.join(__dirname, "../../migrations"),
      tableName: "knex_migrations",
      loadExtensions: [path.extname(__filename)],
    },
  };
}
