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
