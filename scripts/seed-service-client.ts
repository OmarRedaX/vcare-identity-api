/**
 * Local development only: upserts a synthetic service client and prints a fresh random secret to stdout, once
 * (docs/service-auth/spec.md section 6.2). Refuses to run when NODE_ENV=production.
 *
 *   npm run seed:service-client                       # care-service, users:read users:status:write, vcare-identity
 *   npm run seed:service-client -- --client-id care-service --scopes "users:read"
 *
 * The secret is never stored in the repository or a fixture. Integration tests do not use this script; they
 * insert rows through a test helper that hashes with the real `PasswordHasher`.
 */
import argon2 from "argon2";
import crypto from "node:crypto";
import knex from "knex";
import { ARGON2_PARAMETERS } from "../src/lib/password/password-hasher";
import { ArgumentError, assertSeedAllowed, parseSeedArgs, pgArrayLiteral } from "./service-client-args";

const UPSERT = `
  INSERT INTO service_clients
      (client_id, name, client_secret_hash, allowed_scopes, allowed_audiences, is_active, created_at, updated_at)
  VALUES (?, ?, ?, ?::text[], ?::text[], true, now(), now())
  ON CONFLICT (client_id) WHERE deleted_at IS NULL DO UPDATE SET
      name = EXCLUDED.name,
      client_secret_hash = EXCLUDED.client_secret_hash,
      previous_secret_hash = NULL,
      previous_secret_expires_at = NULL,
      allowed_scopes = EXCLUDED.allowed_scopes,
      allowed_audiences = EXCLUDED.allowed_audiences,
      is_active = true,
      secret_rotated_at = now(),
      updated_at = now()
`;

async function main(): Promise<void> {
  assertSeedAllowed(process.env.NODE_ENV);
  const args = parseSeedArgs(process.argv.slice(2));

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new ArgumentError("DATABASE_URL is required");
  }

  const secret = crypto.randomBytes(32).toString("base64url");
  const secretHash = await argon2.hash(secret, { type: argon2.argon2id, ...ARGON2_PARAMETERS });

  const conn = knex({ client: "pg", connection: databaseUrl, pool: { min: 0, max: 1 } });
  try {
    await conn.raw(UPSERT, [
      args.clientId,
      args.name,
      secretHash,
      pgArrayLiteral(args.scopes),
      pgArrayLiteral(args.audiences),
    ]);
  } finally {
    await conn.destroy();
  }

  process.stdout.write(`client_id=${args.clientId}\nclient_secret=${secret}\n`);
}

void main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof ArgumentError ? err.message : "seeding failed"}\n`);
  process.exit(1);
});
