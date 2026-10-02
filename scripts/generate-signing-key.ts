/**
 * Prints one `JWT_PRIVATE_KEYS` entry for a fresh Ed25519 keypair (ADR 0002).
 *
 *   npm run keys:generate -- --kid identity-2026-09
 *
 * The private key is printed **once, to stdout** and never written to a file: paste it into the secret
 * store (or your local `.env`), never into the repository. Rotation: add the new entry in front of the old
 * one, publish for at least one access-token TTL, then point `JWT_ACTIVE_KID` at it, and retire the old key
 * after the refresh TTL (spec §5.1).
 */
import crypto from "node:crypto";

const KID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function defaultKid(): string {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `identity-${String(now.getUTCFullYear())}-${month}`;
}

function main(): void {
  const kid = argument("kid") ?? defaultKid();
  if (!KID_PATTERN.test(kid)) {
    process.stderr.write("kid must match ^[A-Za-z0-9._-]{1,64}$\n");
    process.exit(1);
  }

  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });

  const entry = {
    kid,
    privateJwk: { kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x },
  };

  process.stdout.write(`JWT_ACTIVE_KID=${kid}\n`);
  process.stdout.write(`JWT_PRIVATE_KEYS=${JSON.stringify([entry])}\n`);
}

main();
