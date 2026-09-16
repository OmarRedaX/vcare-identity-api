import "reflect-metadata";
import fs from "node:fs";
import path from "node:path";

/**
 * Loads .env.test when present. Variables already set in the real environment win, so CI values apply.
 * No infrastructure mocks live here (CLAUDE.md -> Testing policy).
 *
 * The file is parsed and assigned here instead of through `process.loadEnvFile`: that call mutates the Jest
 * worker's real process object, while every test file receives a copy of `process.env` taken before
 * `setupFiles` runs — so the first file in each worker would start without DATABASE_URL and exit(1).
 */
function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.length > 1 && /^(".*"|'.*')$/s.test(value)) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

const envFile = path.resolve(process.cwd(), ".env.test");
if (fs.existsSync(envFile)) {
  for (const [key, value] of Object.entries(parseEnvFile(fs.readFileSync(envFile, "utf8")))) {
    const existing = process.env[key];
    if (existing === undefined || existing.length === 0) {
      process.env[key] = value;
    }
  }
}
