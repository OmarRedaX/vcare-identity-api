import {
  EnvRequirementError,
  requireApiConfig,
  requireAppBaseUrl,
  requireEmailConfig,
  requireOtpPepper,
  requireSigningConfig,
  requireWorkerConfig,
} from "../../../../src/lib/config/requirements";
import { envSchema } from "../../../../src/lib/config/env.schema";
import type { Env } from "../../../../src/lib/config/types";
import { generateKeyEntry } from "../../../helpers/keys";

const PEPPER = "synthetic-otp-pepper-value-0123456789abcdef";

function env(overrides: Partial<Env>): Env {
  return overrides as Env;
}

function missingKeysOf(run: () => unknown): string[] {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(EnvRequirementError);
    return [...(err as EnvRequirementError).missingKeys];
  }
  throw new Error("expected an EnvRequirementError");
}

describe("requireSigningConfig", () => {
  it("should default the active kid to the first key when JWT_ACTIVE_KID is unset", () => {
    const first = generateKeyEntry("first");

    expect(requireSigningConfig(env({ JWT_PRIVATE_KEYS: [first] })).activeKid).toBe("first");
  });

  it("should name JWT_PRIVATE_KEYS when the variable is absent or empty", () => {
    expect(missingKeysOf(() => requireSigningConfig(env({})))).toEqual(["JWT_PRIVATE_KEYS"]);
    expect(missingKeysOf(() => requireSigningConfig(env({ JWT_PRIVATE_KEYS: [] })))).toEqual([
      "JWT_PRIVATE_KEYS",
    ]);
  });
});

describe("requireOtpPepper and requireAppBaseUrl", () => {
  it("should return the value when it is configured", () => {
    expect(requireOtpPepper(env({ OTP_PEPPER: PEPPER }))).toBe(PEPPER);
    expect(requireAppBaseUrl(env({ APP_BASE_URL: "https://app.example.test" }))).toBe(
      "https://app.example.test",
    );
  });

  it("should name the missing variable when it is absent", () => {
    expect(missingKeysOf(() => requireOtpPepper(env({})))).toEqual(["OTP_PEPPER"]);
    expect(missingKeysOf(() => requireAppBaseUrl(env({})))).toEqual(["APP_BASE_URL"]);
  });

  it("should never echo the pepper in the error when it is missing", () => {
    try {
      requireOtpPepper(env({}));
    } catch (err) {
      expect((err as Error).message).toBe("invalid_environment");
      expect(`${(err as Error).message}${(err as Error).stack ?? ""}`).not.toContain(PEPPER);
    }
  });
});

describe("requireEmailConfig", () => {
  it("should return the capture adapter configuration when EMAIL_PROVIDER is capture", () => {
    expect(
      requireEmailConfig(
        env({
          EMAIL_PROVIDER: "capture",
          EMAIL_PROVIDER_FROM: "no-reply@example.test",
          EMAIL_CAPTURE_DIR: ".local/mail-test",
        }),
      ),
    ).toEqual({ kind: "capture", from: "no-reply@example.test", directory: ".local/mail-test" });
  });

  it("should return the resend configuration when EMAIL_PROVIDER is resend", () => {
    expect(
      requireEmailConfig(
        env({
          EMAIL_PROVIDER: "resend",
          EMAIL_PROVIDER_FROM: "no-reply@example.test",
          EMAIL_PROVIDER_API_KEY: "synthetic-key",
          EMAIL_PROVIDER_BASE_URL: "https://api.resend.com",
        }),
      ),
    ).toEqual({
      kind: "resend",
      apiKey: "synthetic-key",
      from: "no-reply@example.test",
      baseUrl: "https://api.resend.com",
    });
  });

  it("should name every missing email variable when resend is selected without its secret", () => {
    expect(missingKeysOf(() => requireEmailConfig(env({ EMAIL_PROVIDER: "resend" })))).toEqual([
      "EMAIL_PROVIDER_FROM",
      "EMAIL_PROVIDER_API_KEY",
    ]);
  });
});

describe("requireApiConfig and requireWorkerConfig", () => {
  it("should accept an API environment with signing keys and a pepper", () => {
    expect(() => {
      requireApiConfig(env({ JWT_PRIVATE_KEYS: [generateKeyEntry("api")], OTP_PEPPER: PEPPER }));
    }).not.toThrow();
  });

  it("should collect every missing API variable when both are absent", () => {
    expect(missingKeysOf(() => {
      requireApiConfig(env({}));
    })).toEqual(["JWT_PRIVATE_KEYS", "OTP_PEPPER"]);
  });

  it("should not require signing keys for the worker, nor the email key for the API", () => {
    expect(() => {
      requireWorkerConfig(
        env({
          OTP_PEPPER: PEPPER,
          APP_BASE_URL: "https://app.example.test",
          EMAIL_PROVIDER: "capture",
          EMAIL_PROVIDER_FROM: "no-reply@example.test",
          EMAIL_CAPTURE_DIR: ".local/mail-test",
        }),
      );
    }).not.toThrow();

    expect(missingKeysOf(() => {
      requireWorkerConfig(env({ OTP_PEPPER: PEPPER }));
    })).toEqual(["APP_BASE_URL", "EMAIL_PROVIDER", "EMAIL_PROVIDER_FROM"]);
  });
});

describe("env schema secrets", () => {
  const base = {
    DATABASE_URL: "postgres://identity:identity@localhost:5432/vcare_identity_test",
    REDIS_URL: "redis://localhost:6379/1",
  };

  it("should give no default to any secret when the schema is parsed", () => {
    const parsed = envSchema.parse({ ...base });

    expect(parsed.JWT_PRIVATE_KEYS).toBeUndefined();
    expect(parsed.OTP_PEPPER).toBeUndefined();
    expect(parsed.EMAIL_PROVIDER_API_KEY).toBeUndefined();
  });

  it("should refuse the capture email adapter when NODE_ENV is production", () => {
    const result = envSchema.safeParse({
      ...base,
      NODE_ENV: "production",
      EMAIL_PROVIDER: "capture",
    });

    expect(result.success).toBe(false);
  });

  it("should refuse a pepper shorter than 32 characters", () => {
    expect(envSchema.safeParse({ ...base, OTP_PEPPER: "too-short" }).success).toBe(false);
  });

  it("should refuse a JWT_ACTIVE_KID that names no configured key", () => {
    const entry = generateKeyEntry("configured");
    const result = envSchema.safeParse({
      ...base,
      JWT_PRIVATE_KEYS: JSON.stringify([entry]),
      JWT_ACTIVE_KID: "absent",
    });

    expect(result.success).toBe(false);
  });

  it("should never echo the key material when JWT_PRIVATE_KEYS is malformed", () => {
    const entry = generateKeyEntry("leaky");
    const result = envSchema.safeParse({
      ...base,
      JWT_PRIVATE_KEYS: JSON.stringify([{ kid: entry.kid, privateJwk: { ...entry.privateJwk, crv: "P-256" } }]),
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain(entry.privateJwk.d);
  });
});
