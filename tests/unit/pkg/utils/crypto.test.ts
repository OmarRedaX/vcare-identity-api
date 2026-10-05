import {
  hmacSha256Hex,
  randomDigits,
  randomToken,
  randomUuid,
  sha256Hex,
  timingSafeEqualHex,
} from "../../../../src/pkg/utils/crypto";

const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;

describe("randomToken", () => {
  it("should return 43 unpadded base64url characters when the default size is used", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(randomToken()).toMatch(BASE64URL_43);
    }
  });

  it("should return a different value on every call when called repeatedly", () => {
    const values = new Set(Array.from({ length: 50 }, () => randomToken()));

    expect(values.size).toBe(50);
  });
});

describe("randomUuid", () => {
  it("should return a v4 UUID when called", () => {
    expect(randomUuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("randomDigits", () => {
  it("should always return exactly six digits, leading zeros included, when six are asked for", () => {
    for (let i = 0; i < 300; i += 1) {
      expect(randomDigits(6)).toMatch(/^[0-9]{6}$/);
    }
  });

  it("should zero-pad short draws when the drawn number has fewer digits", () => {
    // 1 digit of entropy makes a left-padded 6-character string observable without faking the CSPRNG.
    const drawn = Array.from({ length: 200 }, () => randomDigits(1));

    expect(drawn.every((value) => /^[0-9]$/.test(value))).toBe(true);
    expect(new Set(drawn).size).toBeGreaterThan(1);
  });

  it("should throw RangeError when the length is not a usable integer", () => {
    expect(() => randomDigits(0)).toThrow(RangeError);
    expect(() => randomDigits(16)).toThrow(RangeError);
    expect(() => randomDigits(1.5)).toThrow(RangeError);
  });
});

describe("sha256Hex and hmacSha256Hex", () => {
  it("should match the published digest when a known vector is hashed", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("should match the published digest when a known HMAC vector is computed", () => {
    expect(hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog")).toBe(
      "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
  });

  it("should produce a different digest for the same code under a different pepper", () => {
    expect(hmacSha256Hex("pepper-one", "123456")).not.toBe(hmacSha256Hex("pepper-two", "123456"));
  });

  it("should return 64 lowercase hex characters when hashing, matching the CHAR(64) columns", () => {
    expect(sha256Hex(randomToken())).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacSha256Hex("pepper", "000000")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("timingSafeEqualHex", () => {
  it("should return true when both digests are identical", () => {
    const digest = sha256Hex("same");

    expect(timingSafeEqualHex(digest, digest)).toBe(true);
  });

  it("should return false when the digests differ", () => {
    expect(timingSafeEqualHex(sha256Hex("a"), sha256Hex("b"))).toBe(false);
  });

  it("should return false without throwing when the lengths differ", () => {
    expect(timingSafeEqualHex("abc", sha256Hex("a"))).toBe(false);
    expect(timingSafeEqualHex("", sha256Hex("a"))).toBe(false);
  });
});
