import { buildKnexConfig, buildKnexLog, buildMigrationSource, migrationConfig } from "../../../../src/lib/knex/knexfile";

interface ConnectionShape {
  connectionString: string;
  statement_timeout?: number;
}

type AfterCreate = (
  conn: { query: (sql: string, cb: (err: Error | null) => void) => void },
  done: (err: Error | null, connection: unknown) => void,
) => void;

const DATABASE_URL = "postgres://identity:identity@localhost:5432/vcare_identity_test";

describe("buildKnexConfig", () => {
  it("should set the statement timeout on the connection when one is given", () => {
    const config = buildKnexConfig({ databaseUrl: DATABASE_URL, poolMax: 10, statementTimeoutMs: 2000 });
    const connection = config.connection as ConnectionShape;

    expect(config.client).toBe("pg");
    expect(connection.connectionString).toBe(DATABASE_URL);
    expect(connection.statement_timeout).toBe(2000);
  });

  it("should omit the statement timeout when it is null", () => {
    const config = buildKnexConfig({ databaseUrl: DATABASE_URL, poolMax: 2, statementTimeoutMs: null });
    const connection = config.connection as ConnectionShape;

    expect("statement_timeout" in connection).toBe(false);
  });

  it("should set every pooled connection to UTC when afterCreate runs", () => {
    const config = buildKnexConfig({ databaseUrl: DATABASE_URL, poolMax: 10, statementTimeoutMs: 2000 });
    const afterCreate = config.pool?.afterCreate as unknown as AfterCreate;
    const statements: string[] = [];
    const done = jest.fn();

    afterCreate(
      {
        query: (sql, cb) => {
          statements.push(sql);
          cb(null);
        },
      },
      done,
    );

    expect(statements).toEqual(["SET TIME ZONE 'UTC'"]);
    expect(done).toHaveBeenCalledWith(null, expect.anything());
  });

  it("should fast-fail on pool waits when the pool is exhausted", () => {
    const config = buildKnexConfig({ databaseUrl: DATABASE_URL, poolMax: 10, statementTimeoutMs: 2000 });

    expect(config.pool?.min).toBe(0);
    expect(config.pool?.max).toBe(10);
    expect(config.pool?.acquireTimeoutMillis).toBe(1000);
    expect(config.acquireConnectionTimeout).toBe(1000);
  });
});

describe("migrationConfig", () => {
  it("should run migrations without a statement timeout on a small pool", () => {
    const config = migrationConfig(DATABASE_URL);
    const connection = config.connection as ConnectionShape;

    expect("statement_timeout" in connection).toBe(false);
    expect(config.pool?.max).toBe(2);
    expect(config.migrations?.tableName).toBe("knex_migrations");
    expect(String(config.migrations?.directory)).toContain("migrations");
  });
});

describe("buildKnexLog", () => {
  const makeLogger = () => ({ debug: jest.fn(), warn: jest.fn(), error: jest.fn() });

  it("should route Knex warnings through the logger with only the first line when the message has a stack", () => {
    const logger = makeLogger();
    const log = buildKnexLog(logger);

    log.warn?.("Acquire connection error: Error: connect ECONNREFUSED\n    at TCPConnectWrap.afterConnect");

    expect(logger.warn).toHaveBeenCalledWith("knex_warn", { detail: "Acquire connection error: Error: connect ECONNREFUSED" });
  });

  it("should route Knex errors and deprecations through the logger when they occur", () => {
    const logger = makeLogger();
    const log = buildKnexLog(logger);

    log.error?.(new Error("pool failed\nstack"));
    log.deprecate?.("oldMethod", "newMethod");

    expect(logger.error).toHaveBeenCalledWith("knex_error", { detail: "pool failed" });
    expect(logger.warn).toHaveBeenCalledWith("knex_deprecated", { method: "oldMethod", alternative: "newMethod" });
  });

  it("should install the structured log only when a logger is given", () => {
    const logger = makeLogger();

    expect(buildKnexConfig({ databaseUrl: DATABASE_URL, poolMax: 1, statementTimeoutMs: 2000 }).log).toBeUndefined();
    expect(buildKnexConfig({ databaseUrl: DATABASE_URL, poolMax: 1, statementTimeoutMs: 2000, logger }).log?.enableColors).toBe(false);
    expect(migrationConfig(DATABASE_URL, logger).log).toBeDefined();
  });
});

describe("client-side bounds and migration names", () => {
  it("should bound connect, query and idle sockets when building the request pool", () => {
    const config = buildKnexConfig({ databaseUrl: DATABASE_URL, poolMax: 10, statementTimeoutMs: 2000 });
    const connection = config.connection as Record<string, unknown>;

    expect(connection.connectionTimeoutMillis).toBe(2000);
    expect(connection.query_timeout).toBe(3000);
    expect(connection.keepAlive).toBe(true);
    expect(connection.keepAliveInitialDelayMillis).toBe(10_000);
    expect(config.pool?.createTimeoutMillis).toBe(2000);
  });

  it("should not impose a query timeout when migrating", () => {
    const connection = migrationConfig(DATABASE_URL).connection as Record<string, unknown>;

    expect("query_timeout" in connection).toBe(false);
  });

  it("should record migration names without the file extension when using the migration source", () => {
    const source = buildMigrationSource(__dirname, ".ts");

    expect(source.getMigrationName("20260915000000_create_citext_extension.ts")).toBe(
      "20260915000000_create_citext_extension",
    );
    expect(source.getMigrationName("20260915000000_create_citext_extension.js".replace(".js", ".ts"))).not.toContain(".");
  });
});
