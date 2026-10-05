import type { EmailConfig, Env, SigningConfig } from "./types";

/**
 * Per-process environment requirements (spec §5.7). Variables only one process needs are optional in
 * `env.schema.ts`; the entrypoint asserts its own set here and exits 1 on failure, so the API never needs the
 * email API key, the worker never needs signing keys, and the migration CLI needs neither.
 *
 * The error carries variable **names** only (CLAUDE.md -> Privacy and logging).
 */
export class EnvRequirementError extends Error {
  readonly missingKeys: readonly string[];

  constructor(missingKeys: readonly string[]) {
    super("invalid_environment");
    this.name = "EnvRequirementError";
    this.missingKeys = missingKeys;
  }
}

/** The signing key set and the kid to sign with. Throws at API boot, never on a request path. */
export function requireSigningConfig(env: Env): SigningConfig {
  const keys = env.JWT_PRIVATE_KEYS;
  if (keys === undefined || keys.length === 0 || keys[0] === undefined) {
    throw new EnvRequirementError(["JWT_PRIVATE_KEYS"]);
  }
  return { keys, activeKid: env.JWT_ACTIVE_KID ?? keys[0].kid };
}

/** The HMAC key for registration and password-reset codes (ADR 0006, ADR 0017). */
export function requireOtpPepper(env: Env): string {
  if (env.OTP_PEPPER === undefined) {
    throw new EnvRequirementError(["OTP_PEPPER"]);
  }
  return env.OTP_PEPPER;
}

/** Base URL of the web client, used in email text only (worker). */
export function requireAppBaseUrl(env: Env): string {
  if (env.APP_BASE_URL === undefined) {
    throw new EnvRequirementError(["APP_BASE_URL"]);
  }
  return env.APP_BASE_URL;
}

/** The selected email adapter's configuration (worker). `capture` is refused in production by env.schema. */
export function requireEmailConfig(env: Env): EmailConfig {
  const missing: string[] = [];
  if (env.EMAIL_PROVIDER === undefined) {
    missing.push("EMAIL_PROVIDER");
  }
  if (env.EMAIL_PROVIDER_FROM === undefined) {
    missing.push("EMAIL_PROVIDER_FROM");
  }
  if (env.EMAIL_PROVIDER === "resend" && env.EMAIL_PROVIDER_API_KEY === undefined) {
    missing.push("EMAIL_PROVIDER_API_KEY");
  }
  if (missing.length > 0 || env.EMAIL_PROVIDER_FROM === undefined) {
    throw new EnvRequirementError(missing.length > 0 ? missing : ["EMAIL_PROVIDER_FROM"]);
  }

  if (env.EMAIL_PROVIDER === "capture") {
    return { kind: "capture", from: env.EMAIL_PROVIDER_FROM, directory: env.EMAIL_CAPTURE_DIR };
  }
  if (env.EMAIL_PROVIDER_API_KEY === undefined) {
    throw new EnvRequirementError(["EMAIL_PROVIDER_API_KEY"]);
  }
  return {
    kind: "resend",
    apiKey: env.EMAIL_PROVIDER_API_KEY,
    from: env.EMAIL_PROVIDER_FROM,
    baseUrl: env.EMAIL_PROVIDER_BASE_URL,
  };
}

function collect(checks: readonly (() => void)[]): void {
  const missing: string[] = [];
  for (const check of checks) {
    try {
      check();
    } catch (err) {
      if (err instanceof EnvRequirementError) {
        missing.push(...err.missingKeys);
        continue;
      }
      throw err;
    }
  }
  if (missing.length > 0) {
    throw new EnvRequirementError([...new Set(missing)].sort());
  }
}

/** Called by `src/server.ts` before the listeners bind. */
export function requireApiConfig(env: Env): void {
  collect([
    () => {
      requireSigningConfig(env);
    },
    () => {
      requireOtpPepper(env);
    },
  ]);
}

/** Called by `src/worker.ts` before the loops start. */
export function requireWorkerConfig(env: Env): void {
  collect([
    () => {
      requireOtpPepper(env);
    },
    () => {
      requireAppBaseUrl(env);
    },
    () => {
      requireEmailConfig(env);
    },
  ]);
}
