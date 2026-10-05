import type { JwksDocument, SigningKeySet } from "./types";

/**
 * The bare JWK Set served at `GET /.well-known/jwks.json` (BR-26). Built once at boot from memory —
 * the hot path touches neither Postgres nor Redis (budget p95 < 10 ms) — and never contains `d`.
 */
export function buildJwks(keys: SigningKeySet): JwksDocument {
  return Object.freeze({ keys: keys.publicJwks });
}
