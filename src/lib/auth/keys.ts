import { createPrivateKey, createPublicKey } from "node:crypto";
import type { CryptoKey } from "jose";
import { EnvRequirementError, requireSigningConfig } from "../config/requirements";
import type { Env, SigningKeyEntry } from "../config/types";
import type { Jwk, SigningKeySet } from "./types";

const ALGORITHM = "Ed25519";

/**
 * Loads the Ed25519 key set from JWT_PRIVATE_KEYS (ADR 0002). Any failure throws
 * `EnvRequirementError(["JWT_PRIVATE_KEYS"])`, whose message carries variable **names** only — key
 * material never reaches a log, the database, or the JWKS document (`d` is never published).
 *
 * Synchronous on purpose: the DI container resolves the key set lazily on first use, so the worker and the
 * migration CLI never parse keys at all (spec §5.8).
 */
function importEntry(entry: SigningKeyEntry): { privateKey: CryptoKey; publicKey: CryptoKey } {
  const privateKeyObject = createPrivateKey({ key: entry.privateJwk, format: "jwk" });

  // The declared public half must really belong to the private scalar.
  const derived = createPublicKey(privateKeyObject).export({ format: "jwk" });
  if (derived.x !== entry.privateJwk.x || derived.crv !== entry.privateJwk.crv) {
    throw new EnvRequirementError(["JWT_PRIVATE_KEYS"]);
  }

  const publicKeyObject = createPublicKey({
    key: { kty: entry.privateJwk.kty, crv: entry.privateJwk.crv, x: entry.privateJwk.x },
    format: "jwk",
  });

  return {
    privateKey: privateKeyObject.toCryptoKey(ALGORITHM, false, ["sign"]),
    publicKey: publicKeyObject.toCryptoKey(ALGORITHM, false, ["verify"]),
  };
}

export function loadSigningKeys(env: Env): SigningKeySet {
  const config = requireSigningConfig(env);

  const verifyKeys = new Map<string, CryptoKey>();
  const publicJwks: Jwk[] = [];
  let signingKey: CryptoKey | undefined;

  for (const entry of config.keys) {
    let imported: { privateKey: CryptoKey; publicKey: CryptoKey };
    try {
      imported = importEntry(entry);
    } catch (err) {
      if (err instanceof EnvRequirementError) {
        throw err;
      }
      throw new EnvRequirementError(["JWT_PRIVATE_KEYS"]);
    }

    verifyKeys.set(entry.kid, imported.publicKey);
    // Published in JWT_PRIVATE_KEYS order: current first, previous after (spec §5.1).
    publicJwks.push({
      kty: "OKP",
      crv: "Ed25519",
      x: entry.privateJwk.x,
      kid: entry.kid,
      alg: "EdDSA",
      use: "sig",
    });
    if (entry.kid === config.activeKid) {
      signingKey = imported.privateKey;
    }
  }

  if (signingKey === undefined) {
    throw new EnvRequirementError(["JWT_ACTIVE_KID"]);
  }

  return Object.freeze({
    activeKid: config.activeKid,
    signingKey,
    verifyKeys,
    publicJwks: Object.freeze(publicJwks),
  });
}
