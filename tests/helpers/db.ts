import { db, probeDb } from "../../src/lib/knex/knex";

const BOOKKEEPING_TABLES = ["knex_migrations", "knex_migrations_lock"];

/** Truncates every business table between suites; knex bookkeeping is preserved. */
export async function truncateAll(): Promise<void> {
  const result = await db.raw<{ rows: { tablename: string }[] }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  );
  const tables = result.rows
    .map((row) => row.tablename)
    .filter((name) => !BOOKKEEPING_TABLES.includes(name));

  if (tables.length === 0) {
    return;
  }

  const list = tables.map((name) => `"${name}"`).join(", ");
  await db.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export async function closeDb(): Promise<void> {
  await Promise.all([db.destroy(), probeDb.destroy()]);
}
