import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

/**
 * Pure CSPRNG and hashing helpers — no env, no singletons (CLAUDE.md -> Folder structure and layering).
 * Callers never log an input or an output of this module.
 */

/** 256-bit refresh token by default: base64url, unpadded (43 characters for 32 bytes). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function randomUuid(): string {
  return randomUUID();
}

/** Uniform CSPRNG digits, zero-padded, e.g. `randomDigits(6)` -> "004219". */
export function randomDigits(length: number): string {
  if (!Number.isInteger(length) || length < 1 || length > 15) {
    throw new RangeError("length must be an integer between 1 and 15");
  }
  return String(randomInt(0, 10 ** length)).padStart(length, "0");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Keyed hash for one-time codes: a database dump alone cannot brute-force the code space (ADR 0017). */
export function hmacSha256Hex(key: string, input: string): string {
  return createHmac("sha256", key).update(input, "utf8").digest("hex");
}

/** Constant-time comparison of two hex digests; false (fast) when the lengths differ. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
