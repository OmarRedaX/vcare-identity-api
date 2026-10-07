import type { CryptoKey } from "jose";
import type { Logger } from "../logger/logger";
import type { AccountStatus, Role } from "../rbac/types";
import type { Clock } from "../time/types";
import type { ServiceAuth } from "../types/types";

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

/** The claims source for a service token: the verified client and what was granted (spec section 3.3 step 7). */
export interface SignableService {
  clientId: string;
  audience: string;
  scopes: readonly string[];
}

/** Why the service guard refused a token. Logged; never put in the response (spec section 3.4). */
export type ServiceTokenFailure =
  | "malformed"
  | "bad_signature"
  | "unknown_kid"
  | "bad_issuer"
  | "expired"
  | "wrong_type"
  | "wrong_audience"
  | "bad_claims";

export type ServiceTokenVerification =
  | { ok: true; auth: ServiceAuth }
  | { ok: false; reason: ServiceTokenFailure };

export interface ServiceGuardDeps {
  keys: SigningKeySet;
  clock: Clock;
  /** Defaults to the process logger; tests pass a capturing one. */
  logger?: Logger;
}
