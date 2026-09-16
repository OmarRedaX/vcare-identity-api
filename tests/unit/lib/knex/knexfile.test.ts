import { buildKnexConfig, migrationConfig } from "../../../../src/lib/knex/knexfile";

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
