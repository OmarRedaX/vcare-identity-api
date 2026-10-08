import { errors, jwtVerify, SignJWT, type CryptoKey, type JWTHeaderParameters } from "jose";
import { TokenExpired, Unauthorized } from "../error/errors";
import { isAccountStatus, isRole } from "../rbac/types";
import type { Clock } from "../time/types";
import type { ServiceAuth, UserAuth } from "../types/types";
import { randomUuid } from "../../pkg/utils/crypto";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  CLOCK_TOLERANCE_SECONDS,
  JWT_ISSUER,
  SELF_AUDIENCE,
  SERVICE_CLIENT_ID_PATTERN,
  SERVICE_TOKEN_TTL_SECONDS,
  USER_TOKEN_AUDIENCE,
} from "./constants";
import type {
  ServiceTokenFailure,
  ServiceTokenVerification,
  SignableService,
  SignableUser,
  SigningKeySet,
} from "./types";

const SUBJECT_PATTERN = /^[1-9][0-9]{0,15}$/;

/** Signs the user access token whose claims `contracts/openapi.yaml` fixes (BR-25). */
export class TokenSigner {
  private readonly keys: SigningKeySet;
  private readonly clock: Clock;

  constructor(keys: SigningKeySet, clock: Clock) {
    this.keys = keys;
    this.clock = clock;
  }

  signUserToken(user: SignableUser): Promise<string> {
    const issuedAt = Math.floor(this.clock.now().getTime() / 1000);

    return new SignJWT({
      typ: "user",
      role: user.role,
      status: user.status,
      ev: user.emailVerifiedAt !== null,
    })
      .setProtectedHeader({ alg: "EdDSA", kid: this.keys.activeKid, typ: "JWT" })
      .setIssuer(JWT_ISSUER)
      .setAudience([...USER_TOKEN_AUDIENCE])
      .setSubject(String(user.id))
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SECONDS)
      .setJti(randomUuid())
      .sign(this.keys.signingKey);
  }

  /** Service token (client credentials): `aud` is a single string, `exp = iat + 300` (spec BR-7). */
  signServiceToken(service: SignableService): Promise<string> {
    const issuedAt = Math.floor(this.clock.now().getTime() / 1000);

    return new SignJWT({
      typ: "service",
      scope: service.scopes.join(" "),
    })
      .setProtectedHeader({ alg: "EdDSA", kid: this.keys.activeKid, typ: "JWT" })
      .setIssuer(JWT_ISSUER)
      .setAudience(service.audience)
      .setSubject(service.clientId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + SERVICE_TOKEN_TTL_SECONDS)
      .setJti(randomUuid())
      .sign(this.keys.signingKey);
  }
}

/**
 * Verifies a bearer access token. `alg` is pinned to EdDSA and the key is resolved by `kid`, so neither an
 * unsigned token nor algorithm confusion can pass. Expiry maps to `TokenExpired` (the signature has already
 * been verified at that point); every other defect maps to `Unauthorized`.
 */
export async function verifyUserAccessToken(
  token: string,
  keys: SigningKeySet,
  clock: Clock,
): Promise<UserAuth> {
  const resolveKey = (header: JWTHeaderParameters): CryptoKey => {
    const key = header.kid === undefined ? undefined : keys.verifyKeys.get(header.kid);
    if (key === undefined) {
      throw Unauthorized;
    }
    return key;
  };

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, (header) => resolveKey(header), {
      algorithms: ["EdDSA"],
      issuer: JWT_ISSUER,
      audience: SELF_AUDIENCE,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: clock.now(),
    });
    payload = verified.payload;
  } catch (err) {
    if (err instanceof errors.JWTExpired) {
      throw TokenExpired;
    }
    throw Unauthorized;
  }

  const { sub, typ, role, status, ev, jti } = payload;
  if (
    typ !== "user" ||
    typeof sub !== "string" ||
    !SUBJECT_PATTERN.test(sub) ||
    !isRole(role) ||
    !isAccountStatus(status) ||
    typeof ev !== "boolean" ||
    typeof jti !== "string"
  ) {
    throw Unauthorized;
  }

  const userId = Number(sub);
  if (!Number.isSafeInteger(userId)) {
    throw Unauthorized;
  }

  return { kind: "user", userId, role, status, ev };
}

class UnknownKid extends Error {}

function failureOf(err: unknown): ServiceTokenFailure {
  if (err instanceof UnknownKid) {
    return "unknown_kid";
  }
  if (err instanceof errors.JWTExpired) {
    return "expired";
  }
  if (err instanceof errors.JWTClaimValidationFailed) {
    if (err.claim === "iss") {
      return "bad_issuer";
    }
    if (err.claim === "aud") {
      return "wrong_audience";
    }
    return "bad_claims";
  }
  if (err instanceof errors.JWSSignatureVerificationFailed || err instanceof errors.JOSEAlgNotAllowed) {
    return "bad_signature";
  }
  return "malformed";
}

/**
 * Verifies a service access token with no I/O (spec section 3.4). `alg` is pinned to EdDSA and the key is
 * resolved by `kid`. Returns the failure reason instead of throwing, so the guard can log it and answer with
 * the one `ServiceTokenRequired` response. Expiry is a failure like any other (D-4).
 */
export async function verifyServiceAccessToken(
  token: string,
  keys: SigningKeySet,
  clock: Clock,
): Promise<ServiceTokenVerification> {
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(
      token,
      (header: JWTHeaderParameters): CryptoKey => {
        const key = header.kid === undefined ? undefined : keys.verifyKeys.get(header.kid);
        if (key === undefined) {
          throw new UnknownKid();
        }
        return key;
      },
      {
        algorithms: ["EdDSA"],
        issuer: JWT_ISSUER,
        audience: SELF_AUDIENCE,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: clock.now(),
        // jose checks exp only when present; a token without it must not be accepted as never-expiring.
        requiredClaims: ["exp", "iat", "sub", "jti"],
      },
    );
    payload = verified.payload;
  } catch (err) {
    return { ok: false, reason: failureOf(err) };
  }

  const { sub, typ, scope, jti } = payload;
  if (typ !== "service") {
    return { ok: false, reason: "wrong_type" };
  }
  if (
    typeof sub !== "string" ||
    !SERVICE_CLIENT_ID_PATTERN.test(sub) ||
    typeof scope !== "string" ||
    typeof jti !== "string"
  ) {
    return { ok: false, reason: "bad_claims" };
  }

  const auth: ServiceAuth = {
    kind: "service",
    clientId: sub,
    scopes: scope.split(" ").filter((entry) => entry.length > 0),
  };
  return { ok: true, auth };
}
