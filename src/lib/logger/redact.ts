/**
 * Defence in depth for CLAUDE.md -> Privacy and logging: secrets and PII are never passed to the logger,
 * and if they are, they never reach stdout. Mechanics are identical in care-service; the key list differs.
 */
export const REDACTED = "[REDACTED]";

export const REDACTED_KEYS: readonly string[] = [
  "password",
  "newPassword",
  "currentPassword",
  "passwordHash",
  "token",
  "accessToken",
  "refreshToken",
  "access_token",
  "refresh_token",
  "client_secret",
  "clientSecret",
  "clientSecretHash",
  "tokenHash",
  "codeHash",
  // One-time secrets (ADR 0006, ADR 0017). `code` is deliberately absent: it would hide AppError.code in
  // error logs — callers simply never pass a registration or reset code (spec §9.4).
  "otp",
  "otpPepper",
  "registrationCode",
  "resetCode",
  "privateJwk",
  "jwtPrivateKeys",
  "apiKey",
  "emailProviderApiKey",
  "deviceInfo",
  "authorization",
  "cookie",
  "set-cookie",
  "email",
  "phone",
  "fullName",
];

const MAX_DEPTH = 8;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

const NORMALIZED_KEYS = new Set(REDACTED_KEYS.map(normalizeKey));

export function isRedactedKey(key: string): boolean {
  return NORMALIZED_KEYS.has(normalizeKey(key));
}

function isDropped(value: unknown): boolean {
  return typeof value === "function" || typeof value === "symbol";
}

function serializeError(err: Error, includeStack: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { name: err.name, message: err.message };
  const code = (err as unknown as Record<string, unknown>).code;
  if (typeof code === "string") {
    out.code = code;
  }
  if (includeStack && typeof err.stack === "string") {
    out.stack = err.stack;
  }
  return out;
}

function walk(value: unknown, depth: number, ancestors: WeakSet<object>, includeStack: boolean): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value !== "object") {
    return value;
  }
  if (depth > MAX_DEPTH) {
    return "[Truncated]";
  }
  if (ancestors.has(value)) {
    return "[Circular]";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }

  ancestors.add(value);
  try {
    if (value instanceof Error) {
      return walk(serializeError(value, includeStack), depth, ancestors, includeStack);
    }
    if (Array.isArray(value)) {
      return value
        .filter((entry) => !isDropped(entry))
        .map((entry) => walk(entry, depth + 1, ancestors, includeStack));
    }

    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isDropped(entry)) {
        continue;
      }
      out[key] = isRedactedKey(key) ? REDACTED : walk(entry, depth + 1, ancestors, includeStack);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Returns a redacted copy; the input is never mutated.
 * `includeStack` is false for levels below `error` (stacks are logged only with errors).
 */
export function redact(value: unknown, includeStack = true): unknown {
  return walk(value, 0, new WeakSet<object>(), includeStack);
}
