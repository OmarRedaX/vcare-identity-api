import crypto from "node:crypto";
import { loadSigningKeys } from "../../src/lib/auth/keys";
import type { SigningKeySet } from "../../src/lib/auth/types";
import type { Env, SigningKeyEntry } from "../../src/lib/config/types";

/** Fresh Ed25519 material per call, so no key ever lives in the repository (spec §5.7). */
export function generateKeyEntry(kid: string): SigningKeyEntry {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });

  return {
    kid,
    privateJwk: {
      kty: "OKP",
      crv: "Ed25519",
      d: String(jwk.d),
      x: String(jwk.x),
    },
  };
}

/** Builds an `Env`-shaped stub carrying only the signing variables `loadSigningKeys` reads. */
export function signingEnv(keys: readonly SigningKeyEntry[], activeKid?: string): Env {
  return { JWT_PRIVATE_KEYS: [...keys], JWT_ACTIVE_KID: activeKid } as unknown as Env;
}

export function buildSigningKeySet(kids: readonly string[], activeKid?: string): SigningKeySet {
  const entries = kids.map((kid) => generateKeyEntry(kid));
  return loadSigningKeys(signingEnv(entries, activeKid ?? kids[0]));
}
