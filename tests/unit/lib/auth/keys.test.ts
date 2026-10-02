import crypto from "node:crypto";
import { loadSigningKeys } from "../../../../src/lib/auth/keys";
import { buildJwks } from "../../../../src/lib/auth/jwks";
import { EnvRequirementError } from "../../../../src/lib/config/requirements";
import type { SigningKeyEntry } from "../../../../src/lib/config/types";
import { generateKeyEntry, signingEnv } from "../../../helpers/keys";

describe("loadSigningKeys", () => {
  it("should expose the active signing key and every verify key when the set is valid", () => {
    const current = generateKeyEntry("identity-2026-09");
    const previous = generateKeyEntry("identity-2026-08");

    const keys = loadSigningKeys(signingEnv([current, previous], current.kid));

    expect(keys.activeKid).toBe(current.kid);
    expect([...keys.verifyKeys.keys()]).toEqual([current.kid, previous.kid]);
    expect(keys.publicJwks.map((jwk) => jwk.kid)).toEqual([current.kid, previous.kid]);
  });

  it("should default the active kid to the first entry when JWT_ACTIVE_KID is unset", () => {
    const first = generateKeyEntry("first");
    const second = generateKeyEntry("second");

    expect(loadSigningKeys(signingEnv([first, second])).activeKid).toBe("first");
  });

  it("should throw EnvRequirementError naming JWT_PRIVATE_KEYS when the set is empty", () => {
    expect(() => loadSigningKeys(signingEnv([]))).toThrow(EnvRequirementError);
    try {
      loadSigningKeys(signingEnv([]));
    } catch (err) {
      expect((err as EnvRequirementError).missingKeys).toEqual(["JWT_PRIVATE_KEYS"]);
    }
  });

  it("should throw EnvRequirementError when x does not belong to d", () => {
    const entry = generateKeyEntry("mismatched");
    const other = generateKeyEntry("other");
    const tampered: SigningKeyEntry = {
      kid: entry.kid,
      privateJwk: { ...entry.privateJwk, x: other.privateJwk.x },
    };

    expect(() => loadSigningKeys(signingEnv([tampered]))).toThrow(EnvRequirementError);
  });

  it("should throw EnvRequirementError when the private material is not an Ed25519 key", () => {
    const entry = generateKeyEntry("bad-curve");
    const broken = {
      kid: entry.kid,
      privateJwk: { ...entry.privateJwk, crv: "X25519" },
    } as unknown as SigningKeyEntry;

    expect(() => loadSigningKeys(signingEnv([broken]))).toThrow(EnvRequirementError);
  });

  it("should throw EnvRequirementError naming JWT_ACTIVE_KID when the active kid is not configured", () => {
    const entry = generateKeyEntry("configured");

    try {
      loadSigningKeys(signingEnv([entry], "not-configured"));
      throw new Error("expected a rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvRequirementError);
      expect((err as EnvRequirementError).missingKeys).toEqual(["JWT_ACTIVE_KID"]);
    }
  });

  it("should never carry key material in the error when the key set is rejected", () => {
    const entry = generateKeyEntry("leaky");
    const other = generateKeyEntry("other");
    const tampered: SigningKeyEntry = {
      kid: entry.kid,
      privateJwk: { ...entry.privateJwk, x: other.privateJwk.x },
    };

    try {
      loadSigningKeys(signingEnv([tampered]));
      throw new Error("expected a rejection");
    } catch (err) {
      const serialized = `${(err as Error).message}${(err as Error).stack ?? ""}`;
      expect(serialized).not.toContain(entry.privateJwk.d);
      expect(serialized).not.toContain(entry.privateJwk.x);
    }
  });
});

describe("buildJwks", () => {
  it("should publish only public fields, in configuration order, when the document is built", () => {
    const current = generateKeyEntry("kid-current");
    const previous = generateKeyEntry("kid-previous");
    const keys = loadSigningKeys(signingEnv([current, previous], current.kid));

    const document = buildJwks(keys);
    const serialized = JSON.stringify(document);

    expect(document.keys.map((jwk) => jwk.kid)).toEqual(["kid-current", "kid-previous"]);
    for (const jwk of document.keys) {
      expect(Object.keys(jwk).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x"]);
      expect(jwk).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig" });
    }
    expect(serialized).not.toContain('"d"');
    expect(serialized).not.toContain(current.privateJwk.d);
    expect(serialized).not.toContain(previous.privateJwk.d);
  });

  it("should publish an x that verifies a signature made with the private half", () => {
    const entry = generateKeyEntry("round-trip");
    const document = buildJwks(loadSigningKeys(signingEnv([entry], entry.kid)));
    const published = document.keys[0];
    if (published === undefined) {
      throw new Error("expected one published key");
    }

    const message = Buffer.from("synthetic-payload");
    const signature = crypto.sign(
      null,
      message,
      crypto.createPrivateKey({ key: entry.privateJwk, format: "jwk" }),
    );
    const publicKey = crypto.createPublicKey({
      key: { kty: published.kty, crv: published.crv, x: published.x },
      format: "jwk",
    });

    expect(crypto.verify(null, message, publicKey, signature)).toBe(true);
  });
});
