/**
 * Prints the SQL that registers or rotates a service client. It never connects to a database (ADR 0010
 * precedent: provisioning is an ops procedure, not an API; docs/service-auth/spec.md section 6.1).
 *
 *   npm run service-client:sql -- --client-id care-service --name "Care service" \
 *       --scopes "users:read users:status:write" --audiences vcare-identity > new-client.sql
 *   npm run service-client:sql -- --client-id care-service --rotate [--overlap-hours 24 | --leaked] > rotate.sql
 *
 * stdout carries only the SQL, which holds the argon2id hash. The plaintext secret is printed once, to stderr, and
 * goes straight to the caller's secret manager: it is never logged, committed or recoverable. The hash contains
 * `$`, so run the file with `psql -f`; never paste it into an unquoted shell heredoc.
 */
import argon2 from "argon2";
import crypto from "node:crypto";
import { ARGON2_PARAMETERS } from "../src/lib/password/password-hasher";
import { ArgumentError, buildInsertSql, buildRotateSql, parseProvisionArgs } from "./service-client-args";

const SECRET_BANNER = "================ CLIENT SECRET (shown once, store it now) ================";

async function main(): Promise<void> {
  const args = parseProvisionArgs(process.argv.slice(2));

  const secret = crypto.randomBytes(32).toString("base64url");
  const secretHash = await argon2.hash(secret, { type: argon2.argon2id, ...ARGON2_PARAMETERS });

  const sql = args.mode === "new" ? buildInsertSql(args, secretHash) : buildRotateSql(args, secretHash);
  process.stdout.write(`${sql}\n`);
  process.stderr.write(`${SECRET_BANNER}\n${secret}\n${"=".repeat(SECRET_BANNER.length)}\n`);
}

void main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof ArgumentError ? err.message : "provisioning failed"}\n`);
  process.exit(1);
});
