import type Redis from "ioredis";
import { Logger } from "../../../../src/lib/logger/logger";
import { consumeRateLimit, logRateLimited } from "../../../../src/lib/rate-limit/rate-limit";
import type { RateLimitDeps, SlidingWindowOptions } from "../../../../src/lib/rate-limit/types";

const FAMILY = "8f1c4e2a-0000-4000-8000-000000000001";

function logSink(): { logger: Logger; lines: () => Record<string, unknown>[]; text: () => string } {
  const written: string[] = [];
  return {
    logger: new Logger({
      service: "identity-service",
      level: "debug",
      production: false,
      sink: (line) => {
        written.push(line);
      },
    }),
    lines: () =>
      written
        .join("")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    text: () => written.join(""),
  };
}

function fakeRedis(status: string, reply: () => Promise<unknown>): { client: Redis; command: jest.Mock } {
  const command = jest.fn(() => reply());
  const client = {
    get status(): string {
      return status;
    },
    defineCommand: jest.fn(),
    rlSlidingWindow: command,
  } as unknown as Redis;
  return { client, command };
}

const REFRESH_LIMITER: SlidingWindowOptions = {
  name: "refresh-family",
  limit: 30,
  windowMs: 60_000,
  degrade: "fail-open",
};

const CREDENTIAL_LIMITER: SlidingWindowOptions = {
  name: "login-ip-email",
  limit: 5,
  windowMs: 60_000,
  degrade: "fallback",
};

function deps(client: Redis, logger: Logger, now = 1_000_000): RateLimitDeps {
  return { redis: client, logger, fallbackDivisor: 2, now: () => now };
}

describe("consumeRateLimit", () => {
  it("should allow and key by limiter name and subject when Redis answers within budget", async () => {
    const sink = logSink();
    const redis = fakeRedis("ready", () => Promise.resolve([1, 0]));

    await expect(
      consumeRateLimit(REFRESH_LIMITER, FAMILY, deps(redis.client, sink.logger)),
    ).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(redis.command).toHaveBeenCalledWith(
      `rl:refresh-family:${FAMILY}`,
      "30",
      "60000",
      expect.any(String),
    );
  });

  it("should deny with the retry delay when Redis reports the window is full", async () => {
    const sink = logSink();
    const redis = fakeRedis("ready", () => Promise.resolve([0, 17]));

    await expect(
      consumeRateLimit(REFRESH_LIMITER, FAMILY, deps(redis.client, sink.logger)),
    ).resolves.toEqual({ allowed: false, retryAfterSeconds: 17 });
  });

  it("should fail open when the limiter degrades and its mode is fail-open", async () => {
    const sink = logSink();
    const redis = fakeRedis("end", () => Promise.reject(new Error("offline")));

    for (let i = 0; i < 100; i += 1) {
      await expect(
        consumeRateLimit(REFRESH_LIMITER, FAMILY, deps(redis.client, sink.logger)),
      ).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    }
    expect(redis.command).not.toHaveBeenCalled();
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "rate_limiter_degraded", mode: "fail-open" }),
    );
  });

  it("should fall back to the in-process limit when the mode is fallback and Redis is down", async () => {
    const sink = logSink();
    const redis = fakeRedis("end", () => Promise.reject(new Error("offline")));
    const subject = `fallback-subject-${String(Date.now())}`;

    // limit 5 / divisor 2 -> 2 allowed per window.
    const decisions = [];
    for (let i = 0; i < 3; i += 1) {
      decisions.push(await consumeRateLimit(CREDENTIAL_LIMITER, subject, deps(redis.client, sink.logger)));
    }

    expect(decisions.map((decision) => decision.allowed)).toEqual([true, true, false]);
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "rate_limiter_degraded", mode: "fallback" }),
    );
  });

  it("should degrade instead of throwing when the Redis call times out", async () => {
    const sink = logSink();
    const redis = fakeRedis("ready", () => new Promise(() => undefined));
    const subject = `timeout-subject-${String(Date.now())}`;

    await expect(
      consumeRateLimit(CREDENTIAL_LIMITER, subject, deps(redis.client, sink.logger)),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("should never log the subject when a limiter denies", () => {
    const sink = logSink();
    const redis = fakeRedis("ready", () => Promise.resolve([0, 5]));

    logRateLimited(REFRESH_LIMITER.name, false, deps(redis.client, sink.logger));

    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "rate_limited", limiter: "refresh-family", degraded: false }),
    );
    expect(sink.text()).not.toContain(FAMILY);
  });
});
