import { EnvValidationError, loadEnv } from "./load-env";
import type { Env } from "./types";

/**
 * The process refuses to start on invalid environment (CLAUDE.md -> Security rules).
 * The failure line names keys only; the logger is not available yet, so it is written directly.
 */
function loadOrExit(): Env {
  try {
    return loadEnv(process.env);
  } catch (err) {
    if (err instanceof EnvValidationError) {
      process.stdout.write(
        `${JSON.stringify({
          level: "error",
          message: "invalid_environment",
          timestamp: new Date().toISOString(),
          service: "identity-service",
          invalidKeys: err.invalidKeys,
        })}\n`,
      );
      process.exit(1);
    }
    throw err;
  }
}

export const env: Env = loadOrExit();
