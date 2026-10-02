import "reflect-metadata";
import crypto from "node:crypto";
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

function setIfUnset(key: string, value: () => string): void {
  const existing = process.env[key];
  if (existing === undefined || existing.length === 0) {
    process.env[key] = value();
  }
}

const envFile = path.resolve(process.cwd(), ".env.test");
if (fs.existsSync(envFile)) {
  for (const [key, value] of Object.entries(parseEnvFile(fs.readFileSync(envFile, "utf8")))) {
    setIfUnset(key, () => value);
  }
}

/**
 * Auth secrets are generated per run instead of being committed (spec §5.7): a fresh Ed25519 keypair and a
 * random OTP pepper, so no key material ever lives in the repository. Real environment values still win.
 */
const generatedKid = "identity-test";
let keysGenerated = false;
setIfUnset("JWT_PRIVATE_KEYS", () => {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  keysGenerated = true;
  return JSON.stringify([
    { kid: generatedKid, privateJwk: { kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x } },
  ]);
});
if (keysGenerated) {
  // Only when the keys came from here: a supplied key set names its own kid.
  setIfUnset("JWT_ACTIVE_KID", () => generatedKid);
}
setIfUnset("OTP_PEPPER", () => crypto.randomBytes(32).toString("base64url"));
