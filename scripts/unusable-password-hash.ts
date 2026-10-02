/**
 * Prints an argon2id hash of 64 random bytes — a hash **no password can produce**.
 *
 *   npm run admin:unusable-hash
 *
 * Used when ops inserts an admin row by hand (ADR 0010, runbook -> Create an admin account): the account
 * exists and cannot be logged into, and the admin sets a real password through forgot/reset password.
 * The random input is discarded and never printed.
 */
import argon2 from "argon2";
import crypto from "node:crypto";
import { ARGON2_PARAMETERS } from "../src/lib/password/password-hasher";

async function main(): Promise<void> {
  const hash = await argon2.hash(crypto.randomBytes(64).toString("base64url"), {
    type: argon2.argon2id,
    ...ARGON2_PARAMETERS,
  });
  process.stdout.write(`${hash}\n`);
}

void main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
