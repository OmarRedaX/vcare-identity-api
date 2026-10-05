import fs from "node:fs";
import path from "node:path";
import type { Knex } from "knex";
import type { KnexLogger, KnexOptions } from "./types";

const ACQUIRE_TIMEOUT_MS = 1000;
/** Client-side bounds: statement_timeout is server-side and cannot fire when the primary vanishes without RST. */
const CONNECT_TIMEOUT_MS = 2000;
const QUERY_TIMEOUT_MARGIN_MS = 1000;
const TCP_KEEP_ALIVE_INITIAL_DELAY_MS = 10_000;

/** Knex messages may embed a multi-line stack; only the first line is logged, as a field. */
function firstLine(message: unknown): string {
  const text = message instanceof Error ? message.message : String(message);
  return text.split("\n", 1)[0] ?? "";
}

/** Routes Knex's default console output through Logger so every line stays JSON (CLAUDE.md -> Privacy and logging). */
export function buildKnexLog(logger: KnexLogger): Knex.Logger {
  return {
    debug: (message: unknown) => {
      logger.debug("knex_debug", { detail: firstLine(message) });
    },
    warn: (message: unknown) => {
      logger.warn("knex_warn", { detail: firstLine(message) });
    },
    error: (message: unknown) => {
      logger.error("knex_error", { detail: firstLine(message) });
    },
    deprecate: (method: string, alternative: string) => {
      logger.warn("knex_deprecated", { method, alternative });
    },
    enableColors: false,
  };
}

/** Every pooled connection is UTC (CLAUDE.md -> Database rules). */
export function buildKnexConfig(options: KnexOptions): Knex.Config {
  return {
    client: "pg",
    connection: {
      connectionString: options.databaseUrl,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      keepAlive: true,
      keepAliveInitialDelayMillis: TCP_KEEP_ALIVE_INITIAL_DELAY_MS,
      ...(options.statementTimeoutMs === null
        ? {}
        : {
            statement_timeout: options.statementTimeoutMs,
            query_timeout: options.statementTimeoutMs + QUERY_TIMEOUT_MARGIN_MS,
          }),
    },
    pool: {
      min: 0,
      max: options.poolMax,
      acquireTimeoutMillis: ACQUIRE_TIMEOUT_MS,
      createTimeoutMillis: CONNECT_TIMEOUT_MS,
      afterCreate: (conn: { query: (sql: string, cb: (err: Error | null) => void) => void }, done: (err: Error | null, connection: unknown) => void) => {
        conn.query("SET TIME ZONE 'UTC'", (err: Error | null) => {
          done(err, conn);
        });
      },
    },
    acquireConnectionTimeout: ACQUIRE_TIMEOUT_MS,
    ...(options.logger === undefined ? {} : { log: buildKnexLog(options.logger) }),
  };
}

/**
 * Migrations are recorded without their file extension, so the compiled (`dist/*.js`) and tsx (`src/*.ts`)
 * runners agree on one `knex_migrations` table.
 */
export function buildMigrationSource(directory: string, extension: string): Knex.MigrationSource<string> {
  return {
    getMigrations: () =>
      Promise.resolve(
        fs
          .readdirSync(directory)
          .filter((file) => file.endsWith(extension) && !file.endsWith(`.d${extension}`))
          .sort(),
      ),
    getMigrationName: (file: string) => file.slice(0, -extension.length),
    getMigration: (file: string) =>
      import(path.join(directory, file)) as Promise<Knex.Migration>,
  };
}

/** Migrations run without a statement timeout and on a tiny pool. */
export function migrationConfig(databaseUrl: string, logger?: KnexLogger): Knex.Config {
  return {
    ...buildKnexConfig({ databaseUrl, poolMax: 2, statementTimeoutMs: null, ...(logger === undefined ? {} : { logger }) }),
    migrations: {
      directory: path.join(__dirname, "../../migrations"),
      tableName: "knex_migrations",
      loadExtensions: [path.extname(__filename)],
      migrationSource: buildMigrationSource(
        path.join(__dirname, "../../migrations"),
        path.extname(__filename),
      ),
    },
  };
}
