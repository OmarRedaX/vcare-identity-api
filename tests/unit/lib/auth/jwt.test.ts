import crypto from "node:crypto";
import { SignJWT, decodeJwt, decodeProtectedHeader } from "jose";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  JWT_ISSUER,
  USER_TOKEN_AUDIENCE,
} from "../../../../src/lib/auth/constants";
import { TokenSigner, verifyUserAccessToken } from "../../../../src/lib/auth/jwt";
import { loadSigningKeys } from "../../../../src/lib/auth/keys";
import type { SigningKeySet } from "../../../../src/lib/auth/types";
import { AppError } from "../../../../src/lib/error/AppError";
import type { Clock } from "../../../../src/lib/time/types";
import { generateKeyEntry, signingEnv } from "../../../helpers/keys";

const NOW = new Date("2026-09-18T10:00:00.000Z");
const ISSUED_AT = Math.floor(NOW.getTime() / 1000);

function fixedClock(now: Date = NOW): Clock {
  return { now: () => now };
}

const SIGNABLE = {
  id: 42,
  role: "doctor" as const,
  status: "pending" as const,
  emailVerifiedAt: new Date("2026-09-01T00:00:00.000Z"),
};

const current = generateKeyEntry("kid-current");
const previous = generateKeyEntry("kid-previous");
const keys: SigningKeySet = loadSigningKeys(signingEnv([current, previous], "kid-current"));
const keysSigningPrevious: SigningKeySet = loadSigningKeys(
  signingEnv([current, previous], "kid-previous"),
);

/** Signs an arbitrary claim set with the active private key, to forge the defects BR-25 must reject. */
function signClaims(payload: Record<string, unknown>, kid = keys.activeKid): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "EdDSA", kid, typ: "JWT" })
    .setIssuedAt(ISSUED_AT)
    .setExpirationTime(ISSUED_AT + ACCESS_TOKEN_TTL_SECONDS)
    .sign(keys.signingKey);
}

function userClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: JWT_ISSUER,
    aud: [...USER_TOKEN_AUDIENCE],
    sub: "1",
    typ: "user",
    role: "patient",
    status: "active",
    ev: true,
    jti: "00000000-0000-4000-8000-000000000000",
    ...overrides,
  };
}

async function expectRejectedWith(token: string, code: string): Promise<void> {
  try {
    await verifyUserAccessToken(token, keys, fixedClock());
    throw new Error(`expected verification to fail with ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
  }
}

describe("TokenSigner.signUserToken", () => {
  it("should carry exactly the contract claims and the active kid when a user token is signed", async () => {
    const token = await new TokenSigner(keys, fixedClock()).signUserToken(SIGNABLE);

    const header = decodeProtectedHeader(token);
    const payload = decodeJwt(token) as Record<string, unknown>;

    expect(header).toMatchObject({ alg: "EdDSA", kid: "kid-current", typ: "JWT" });
    expect(payload.iss).toBe(JWT_ISSUER);
    expect(payload.aud).toEqual([...USER_TOKEN_AUDIENCE]);
    expect(payload.sub).toBe("42");
    expect(payload.typ).toBe("user");
    expect(payload.role).toBe("doctor");
    expect(payload.status).toBe("pending");
    expect(payload.ev).toBe(true);
    expect(payload.iat).toBe(ISSUED_AT);
    expect(payload.exp).toBe(ISSUED_AT + 900);
    expect(typeof payload.jti).toBe("string");
  });

  it("should set ev false when the account has no verified email", async () => {
    const token = await new TokenSigner(keys, fixedClock()).signUserToken({
      ...SIGNABLE,
      emailVerifiedAt: null,
    });

    expect((decodeJwt(token) as { ev: boolean }).ev).toBe(false);
  });

  it("should use a fresh jti on every signature when the same user signs twice", async () => {
    const signer = new TokenSigner(keys, fixedClock());
    const first = decodeJwt(await signer.signUserToken(SIGNABLE)) as { jti: string };
    const second = decodeJwt(await signer.signUserToken(SIGNABLE)) as { jti: string };

    expect(first.jti).not.toBe(second.jti);
  });
});

describe("verifyUserAccessToken", () => {
  it("should return the principal when a freshly signed token is verified", async () => {
    const token = await new TokenSigner(keys, fixedClock()).signUserToken(SIGNABLE);

    await expect(verifyUserAccessToken(token, keys, fixedClock())).resolves.toEqual({
      kind: "user",
      userId: 42,
      role: "doctor",
      status: "pending",
      ev: true,
    });
  });

  it("should still verify when the token was signed with the previous, non-active key", async () => {
    const token = await new TokenSigner(keysSigningPrevious, fixedClock()).signUserToken(SIGNABLE);

    expect(decodeProtectedHeader(token).kid).toBe("kid-previous");
    await expect(verifyUserAccessToken(token, keys, fixedClock())).resolves.toMatchObject({
      userId: 42,
    });
  });

  it("should throw TokenExpired when the token is past exp beyond the tolerance", async () => {
    const token = await new TokenSigner(keys, fixedClock()).signUserToken(SIGNABLE);
    const later = new Date(NOW.getTime() + (ACCESS_TOKEN_TTL_SECONDS + 31) * 1000);

    await expect(verifyUserAccessToken(token, keys, fixedClock(later))).rejects.toMatchObject({
      code: "TokenExpired",
      status: 401,
    });
  });

  it("should accept a token inside the 30 second clock tolerance when it has just expired", async () => {
    const token = await new TokenSigner(keys, fixedClock()).signUserToken(SIGNABLE);
    const justAfter = new Date(NOW.getTime() + (ACCESS_TOKEN_TTL_SECONDS + 5) * 1000);

    await expect(verifyUserAccessToken(token, keys, fixedClock(justAfter))).resolves.toMatchObject({
      userId: 42,
    });
  });

  it("should throw Unauthorized when the signature was tampered with", async () => {
    const token = await new TokenSigner(keys, fixedClock()).signUserToken(SIGNABLE);
    const [header = "", payload = "", signature = ""] = token.split(".");
    const flipped = `${signature.slice(0, -2)}${signature.slice(-2) === "AA" ? "BB" : "AA"}`;

    await expectRejectedWith(`${header}.${payload}.${flipped}`, "Unauthorized");
  });

  it("should throw Unauthorized when the kid is unknown or missing", async () => {
    await expectRejectedWith(await signClaims(userClaims(), "not-configured"), "Unauthorized");

    const noKid = await new SignJWT(userClaims())
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuedAt(ISSUED_AT)
      .setExpirationTime(ISSUED_AT + 900)
      .sign(keys.signingKey);
    await expectRejectedWith(noKid, "Unauthorized");
  });

  it("should throw Unauthorized when iss or aud is wrong", async () => {
    await expectRejectedWith(await signClaims(userClaims({ iss: "evil" })), "Unauthorized");
    await expectRejectedWith(
      await signClaims(userClaims({ aud: ["vcare-care"] })),
      "Unauthorized",
    );
  });

  it("should throw Unauthorized when the claims are not a well-formed user principal", async () => {
    const defects: Record<string, unknown>[] = [
      { typ: "service" },
      { role: "superuser" },
      { status: "deleted" },
      { ev: "yes" },
      { sub: "not-a-number" },
      { sub: "0" },
      { jti: undefined },
    ];

    for (const defect of defects) {
      await expectRejectedWith(await signClaims(userClaims(defect)), "Unauthorized");
    }
  });

  it("should throw Unauthorized when the token uses alg none or a symmetric algorithm", async () => {
    const claims = userClaims({ exp: ISSUED_AT + 900, iat: ISSUED_AT });
    const b64 = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${b64({ alg: "none", kid: keys.activeKid })}.${b64(claims)}.`;
    await expectRejectedWith(unsigned, "Unauthorized");

    const hmac = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", kid: keys.activeKid })
      .sign(crypto.randomBytes(32));
    await expectRejectedWith(hmac, "Unauthorized");
  });

  it("should throw Unauthorized when the bearer value is not a JWT at all", async () => {
    await expectRejectedWith("not.a.token", "Unauthorized");
    await expectRejectedWith("", "Unauthorized");
  });
});
