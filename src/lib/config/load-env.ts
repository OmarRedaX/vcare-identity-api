import { envSchema } from "./env.schema";
import type { Env } from "./types";

/** Carries the names of the invalid variables — never their values (CLAUDE.md -> Privacy and logging). */
export class EnvValidationError extends Error {
  readonly invalidKeys: readonly string[];

  constructor(invalidKeys: readonly string[]) {
    super("invalid_environment");
    this.name = "EnvValidationError";
    this.invalidKeys = invalidKeys;
  }
}

/** Empty strings are treated as "not set", so a blank line uses the default and a blank secret is missing. */
function withoutEmptyValues(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value.length > 0) {
      result[key] = value;
    }
  }
  return result;
}

export function loadEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(withoutEmptyValues(source));
  if (parsed.success) {
    return parsed.data;
  }

  const invalidKeys = [
    ...new Set(
      parsed.error.issues.map((issue) =>
        issue.path.length > 0 ? issue.path.map((segment) => String(segment)).join(".") : "(root)",
      ),
    ),
  ].sort();

  throw new EnvValidationError(invalidKeys);
}
