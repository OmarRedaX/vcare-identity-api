import { EnvValidationError, loadEnv } from "../../../../src/lib/config/load-env";

const VALID: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://identity:identity@localhost:5432/vcare_identity_test",
  REDIS_URL: "redis://localhost:6379/1",
};

function keysOf(source: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadEnv(source);
  } catch (err) {
    if (err instanceof EnvValidationError) {
      return err.invalidKeys;
    }
    throw err;
  }
  throw new Error("expected loadEnv to throw");
}

describe("loadEnv", () => {
  it("should apply defaults when optional variables are absent", () => {
    const env = loadEnv(VALID);

    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(3000);
    expect(env.INTERNAL_PORT).toBe(3100);
    expect(env.INTERNAL_HOST).toBe("127.0.0.1");
    expect(env.TRUST_PROXY_HOPS).toBe(0);
    expect(env.DATABASE_POOL_MAX).toBe(10);
    expect(env.CORS_ORIGINS).toEqual([]);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.SHUTDOWN_TIMEOUT_MS).toBe(10000);
    expect(env.RATE_LIMIT_FALLBACK_DIVISOR).toBe(2);
    expect(env.WORKER_POLL_INTERVAL_MS).toBe(1000);
  });

  it("should throw naming DATABASE_URL when it is missing", () => {
    expect(keysOf({ REDIS_URL: VALID.REDIS_URL })).toContain("DATABASE_URL");
  });

  it("should throw naming REDIS_URL when it is an empty string", () => {
    expect(keysOf({ ...VALID, REDIS_URL: "" })).toContain("REDIS_URL");
  });

  it("should never include variable values in the error when parsing fails", () => {
    let caught: EnvValidationError | undefined;
    try {
      loadEnv({ ...VALID, DATABASE_URL: "mysql://identity:s3cr3t-fixture@localhost:3306/db" });
    } catch (err) {
      caught = err instanceof EnvValidationError ? err : undefined;
    }

    expect(caught).toBeInstanceOf(EnvValidationError);
    const serialized = `${caught?.message ?? ""}${JSON.stringify(caught?.invalidKeys ?? [])}`;
    expect(serialized).toContain("DATABASE_URL");
    expect(serialized).not.toContain("s3cr3t-fixture");
    expect(serialized).not.toContain("mysql://");
  });

  it("should reject LOG_LEVEL when it is debug and NODE_ENV is production", () => {
    expect(keysOf({ ...VALID, NODE_ENV: "production", LOG_LEVEL: "debug" })).toContain("LOG_LEVEL");
  });

  it("should reject INTERNAL_PORT when it equals PORT", () => {
    expect(keysOf({ ...VALID, PORT: "3100", INTERNAL_PORT: "3100" })).toContain("INTERNAL_PORT");
  });

  it("should parse CORS_ORIGINS into a trimmed list when it is comma separated", () => {
    const env = loadEnv({ ...VALID, CORS_ORIGINS: " http://localhost:5173 , https://app.example.test ," });

    expect(env.CORS_ORIGINS).toEqual(["http://localhost:5173", "https://app.example.test"]);
  });

  it("should reject CORS_ORIGINS when an entry has a path", () => {
    expect(keysOf({ ...VALID, CORS_ORIGINS: "http://localhost:5173/app" })).toContain("CORS_ORIGINS");
  });

  it("should reject DATABASE_URL when the protocol is not postgres", () => {
    expect(keysOf({ ...VALID, DATABASE_URL: "http://localhost:5432/db" })).toContain("DATABASE_URL");
  });
});

describe("loadEnv trust proxy", () => {
  const PRODUCTION = {
    ...VALID,
    NODE_ENV: "production",
    EMAIL_PROVIDER_BASE_URL: "https://api.resend.com",
    DATABASE_URL: "postgres://identity:identity@db.example.test:5432/vcare_identity?sslmode=require",
    REDIS_URL: "rediss://cache.example.test:6379",
  };

  it("should reject TRUST_PROXY_HOPS when it is unset and NODE_ENV is production", () => {
    expect(keysOf(PRODUCTION)).toContain("TRUST_PROXY_HOPS");
  });

  it("should reject TRUST_PROXY_HOPS when it is 0 and NODE_ENV is production", () => {
    expect(keysOf({ ...PRODUCTION, TRUST_PROXY_HOPS: "0" })).toContain("TRUST_PROXY_HOPS");
  });

  it("should accept an explicit hop count and default the internal listener to 0 when in production", () => {
    const env = loadEnv({ ...PRODUCTION, TRUST_PROXY_HOPS: "2" });

    expect(env.TRUST_PROXY_HOPS).toBe(2);
    expect(env.INTERNAL_TRUST_PROXY_HOPS).toBe(0);
  });
});

describe("loadEnv production hardening", () => {
  const SECURE = {
    ...VALID,
    NODE_ENV: "production",
    TRUST_PROXY_HOPS: "1",
    DATABASE_URL: "postgres://identity:identity@db.example.test:5432/vcare_identity?sslmode=require",
    REDIS_URL: "rediss://cache.example.test:6379",
    OTP_PEPPER: "a-production-pepper-with-at-least-32-characters",
    APP_BASE_URL: "https://app.example.test",
  };

  it("should accept a fully hardened production environment", () => {
    expect(() => loadEnv(SECURE)).not.toThrow();
  });

  it("should reject REDIS_URL when it is not rediss and NODE_ENV is production", () => {
    expect(keysOf({ ...SECURE, REDIS_URL: "redis://cache.example.test:6379" })).toContain("REDIS_URL");
  });

  it("should reject DATABASE_URL when sslmode is missing and NODE_ENV is production", () => {
    expect(
      keysOf({ ...SECURE, DATABASE_URL: "postgres://identity:identity@db.example.test:5432/vcare_identity" }),
    ).toContain("DATABASE_URL");
  });

  it("should reject DATABASE_URL when sslmode is disable and NODE_ENV is production", () => {
    expect(
      keysOf({ ...SECURE, DATABASE_URL: "postgres://identity:identity@db.example.test:5432/x?sslmode=disable" }),
    ).toContain("DATABASE_URL");
  });

  it("should reject OTP_PEPPER when it is the development placeholder and NODE_ENV is production", () => {
    expect(keysOf({ ...SECURE, OTP_PEPPER: "local-development-otp-pepper-change-me" })).toContain("OTP_PEPPER");
  });

  it("should reject APP_BASE_URL when it is http and NODE_ENV is production", () => {
    expect(keysOf({ ...SECURE, APP_BASE_URL: "http://app.example.test" })).toContain("APP_BASE_URL");
  });

  it("should keep plain redis, no sslmode, the dev pepper and http base url working when NODE_ENV is development", () => {
    expect(() =>
      loadEnv({
        ...VALID,
        OTP_PEPPER: "local-development-otp-pepper-change-me",
        APP_BASE_URL: "http://localhost:5173",
      }),
    ).not.toThrow();
  });
});
