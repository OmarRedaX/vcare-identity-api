import { closeDb } from "../helpers/db";
import { db } from "../../src/lib/knex/knex";

afterAll(async () => {
  await closeDb();
});

describe("migrations", () => {
  it("should have the citext extension installed when migrations have run", async () => {
    const result = await db.raw<{ rows: { extname: string }[] }>(
      "SELECT extname FROM pg_extension WHERE extname = 'citext'",
    );

    expect(result.rows).toHaveLength(1);
  });

  it("should record the applied migrations in knex_migrations when they have run", async () => {
    const result = await db.raw<{ rows: { name: string }[] }>("SELECT name FROM knex_migrations");

    expect(result.rows.some((row) => row.name.includes("create_citext_extension"))).toBe(true);
  });
});

describe("pooled connections", () => {
  it("should run every pooled connection in UTC when a query is issued", async () => {
    const result = await db.raw<{ rows: { TimeZone: string }[] }>("SHOW TIME ZONE");

    expect(result.rows[0]?.TimeZone).toBe("UTC");
  });

  it("should apply the 2 second statement timeout when a query is issued", async () => {
    const result = await db.raw<{ rows: { statement_timeout: string }[] }>("SHOW statement_timeout");

    expect(result.rows[0]?.statement_timeout).toBe("2s");
  });
});
