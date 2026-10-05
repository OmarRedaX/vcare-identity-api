import "reflect-metadata";
import fs from "node:fs";
import path from "node:path";
import knex from "knex";
import { env } from "./lib/config/env";
import { migrationConfig } from "./lib/knex/knexfile";
import { logger } from "./lib/logger/logger";

const MIGRATIONS_DIR = path.join(__dirname, "migrations");
const NAME_PATTERN = /^[a-z0-9_]+$/;

function timestamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

function template(name: string): string {
  return `import type { Knex } from "knex";

/**
 * ${name}
 * Raw SQL only (CLAUDE.md -> Database rules; write-migration skill).
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(\`
    \`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(\`
    \`);
}
`;
}

function make(name: string | undefined): number {
  if (name === undefined || !NAME_PATTERN.test(name)) {
    logger.error("migration_name_invalid");
    return 1;
  }
  fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
  const file = path.join(MIGRATIONS_DIR, `${timestamp()}_${name}.ts`);
  fs.writeFileSync(file, template(name), "utf8");
  logger.info("migration_created", { file: path.basename(file) });
  return 0;
}

async function runCommand(command: string, args: readonly string[]): Promise<number> {
  const conn = knex(migrationConfig(env.DATABASE_URL, logger));
  try {
    switch (command) {
      case "latest": {
        const [batch, files] = (await conn.migrate.latest()) as [number, string[]];
        logger.info("migrations_applied", { batch, count: files.length, files });
        return 0;
      }
      case "rollback": {
        const all = args.includes("--all");
        const [batch, files] = (await conn.migrate.rollback(undefined, all)) as [number, string[]];
        logger.info("migrations_rolled_back", { batch, count: files.length, files, all });
        return 0;
      }
      case "status": {
        const [completed, pending] = (await conn.migrate.list()) as [string[], { file: string }[]];
        logger.info("migrations_status", {
          completed: completed.length,
          pending: pending.map((entry) => entry.file),
        });
        return 0;
      }
      default:
        logger.error("migration_command_unknown", { command });
        return 1;
    }
  } catch (err) {
    logger.error("migration_failed", { command, err });
    return 1;
  } finally {
    await conn.destroy();
  }
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);

  if (command === undefined) {
    logger.error("migration_command_missing");
    return 1;
  }
  if (command === "make") {
    return make(args[0]);
  }
  return runCommand(command, args);
}

void main().then((code) => {
  process.exit(code);
});
