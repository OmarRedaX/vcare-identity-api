import { SignJWT } from "jose";
import type { User } from "../../src/app/auth/entity/user.entity";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  JWT_ISSUER,
  USER_TOKEN_AUDIENCE,
} from "../../src/lib/auth/constants";
import { TokenSigner } from "../../src/lib/auth/jwt";
import { loadSigningKeys } from "../../src/lib/auth/keys";
import type { SigningKeySet } from "../../src/lib/auth/types";
import { env } from "../../src/lib/config/env";
import { systemClock } from "../../src/lib/time/clock";
import type { Clock } from "../../src/lib/time/types";

/** The run's signing keys (generated in tests/setup.ts), so tests can mint tokens the app accepts. */
export function testSigningKeys(): SigningKeySet {
  return loadSigningKeys(env);
}

export function signAccessToken(user: User, clock: Clock = systemClock): Promise<string> {
  return new TokenSigner(testSigningKeys(), clock).signUserToken(user);
}

/** A token that is correctly signed but already past `exp` + the 30 s tolerance. */
export function signExpiredAccessToken(user: User): Promise<string> {
  const past = new Date(Date.now() - (ACCESS_TOKEN_TTL_SECONDS + 120) * 1000);
  return signAccessToken(user, { now: () => past });
}

/** A correctly signed token whose `typ` is `service` — user routes must refuse it. */
export function signServiceTypedToken(): Promise<string> {
  const keys = testSigningKeys();
  const issuedAt = Math.floor(Date.now() / 1000);

  return new SignJWT({ typ: "service", scope: "users:read" })
    .setProtectedHeader({ alg: "EdDSA", kid: keys.activeKid, typ: "JWT" })
    .setIssuer(JWT_ISSUER)
    .setAudience([...USER_TOKEN_AUDIENCE])
    .setSubject("care-service")
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 300)
    .setJti("00000000-0000-4000-8000-00000000cafe")
    .sign(keys.signingKey);
}

/** Flips the last characters of the signature: a valid shape with a broken signature. */
export function tamperToken(token: string): string {
  const [header = "", payload = "", signature = ""] = token.split(".");
  const flipped = `${signature.slice(0, -2)}${signature.slice(-2) === "AA" ? "BB" : "AA"}`;
  return `${header}.${payload}.${flipped}`;
}
