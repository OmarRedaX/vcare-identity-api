import fs from "node:fs";
import path from "node:path";
import knex from "knex";
import { migrationConfig } from "../../src/lib/knex/knexfile";

/** Runs migrations once before the integration suites (real Postgres, CLAUDE.md -> Testing policy). */
export default async function globalSetup(): Promise<void> {
  const envFile = path.resolve(process.cwd(), ".env.test");
  if (fs.existsSync(envFile)) {
    const preexisting = { ...process.env };
    process.loadEnvFile(envFile);
    for (const [key, value] of Object.entries(preexisting)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required for integration tests");
  }

  const conn = knex(migrationConfig(databaseUrl));
  try {
    // lib/knex fast-fails pool waits after 1 s (spec §4.10). On the first run the loader transpiles the
    // migration files on this thread, which can block the event loop past that budget and surface as a
    // spurious KnexTimeoutError; the retry runs against warm module and connection caches.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await conn.raw("SELECT 1");
        await conn.migrate.latest();
        break;
      } catch (err) {
        if (attempt >= 3) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  } finally {
    await conn.destroy();
  }
}
