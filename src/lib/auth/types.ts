import type { CryptoKey } from "jose";
import type { AccountStatus, Role } from "../rbac/types";

/** A published public key (RFC 7517 / RFC 8037). Never carries `d`. */
export interface Jwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  alg: "EdDSA";
  use: "sig";
}

export interface JwksDocument {
  keys: readonly Jwk[];
}

/** Loaded once at API boot from JWT_PRIVATE_KEYS; frozen. */
export interface SigningKeySet {
  activeKid: string;
  signingKey: CryptoKey;
  verifyKeys: ReadonlyMap<string, CryptoKey>;
  publicJwks: readonly Jwk[];
}

/** The claims source for a user access token — never the whole entity. */
export interface SignableUser {
  id: number;
  role: Role;
  status: AccountStatus;
  emailVerifiedAt: Date | null;
}
