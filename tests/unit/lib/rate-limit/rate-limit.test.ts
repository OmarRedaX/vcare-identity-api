import express, { type ErrorRequestHandler, type Express } from "express";
import type Redis from "ioredis";
import request from "supertest";
import { AppError } from "../../../../src/lib/error/AppError";
import { Logger } from "../../../../src/lib/logger/logger";
import { fallbackLimit, rateLimit } from "../../../../src/lib/rate-limit/rate-limit";
import type { DegradeMode } from "../../../../src/lib/rate-limit/types";

const SUBJECT = "fixture-subject-value";

interface FakeRedis {
  client: Redis;
  command: jest.Mock;
  setStatus: (status: string) => void;
}

interface LogSink {
  logger: Logger;
  lines: () => Record<string, unknown>[];
  text: () => string;
}

function logSink(): LogSink {
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

function fakeRedis(status: string, reply: () => Promise<unknown>): FakeRedis {
  const state = { status };
  const command = jest.fn(() => reply());
  const client = {
    get status(): string {
      return state.status;
    },
    defineCommand: jest.fn(),
    rlSlidingWindow: command,
  } as unknown as Redis;

  return {
    client,
    command,
    setStatus: (next: string) => {
      state.status = next;
    },
  };
}

// Express recognises an error handler by its arity, so the unused fourth parameter has to stay.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const renderError: ErrorRequestHandler = (err, _req, res, _next) => {
  const error = err as AppError;
  res.status(error.status).json({ code: error.code });
};

function buildApp(options: {
  name: string;
  limit: number;
  windowMs?: number;
  degrade: DegradeMode;
  redis: Redis;
  logger: Logger;
  fallbackDivisor?: number;
  now?: () => number;
}): Express {
  const app = express();
  app.get(
    "/limited",
    rateLimit(
      {
        name: options.name,
        limit: options.limit,
        windowMs: options.windowMs ?? 1000,
        subject: () => SUBJECT,
        degrade: options.degrade,
      },
      {
        redis: options.redis,
        logger: options.logger,
        fallbackDivisor: options.fallbackDivisor ?? 2,
        now: options.now ?? (() => Date.now()),
      },
    ),
    (_req, res) => {
      res.status(200).json({ success: true });
    },
  );
  app.use(renderError);
  return app;
}

describe("fallbackLimit", () => {
  it("should never allow fewer than one request when floor(limit / divisor) is zero", () => {
    expect(fallbackLimit(1, 5)).toBe(1);
    expect(fallbackLimit(4, 2)).toBe(2);
    expect(fallbackLimit(5, 2)).toBe(2);
  });
});

describe("rateLimit middleware", () => {
  it("should call next when the script allows the request", async () => {
    const redis = fakeRedis("ready", () => Promise.resolve([1, 0]));
    const app = buildApp({ name: "allow", limit: 3, degrade: "fallback", redis: redis.client, logger: logSink().logger });

    const response = await request(app).get("/limited");

    expect(response.status).toBe(200);
    expect(redis.command).toHaveBeenCalledTimes(1);
  });

  it("should respond 429 RateLimited with Retry-After when the script denies the request", async () => {
    const redis = fakeRedis("ready", () => Promise.resolve([0, 7]));
    const app = buildApp({ name: "deny", limit: 3, degrade: "fallback", redis: redis.client, logger: logSink().logger });

    const response = await request(app).get("/limited");

    expect(response.status).toBe(429);
    expect((response.body as { code: string }).code).toBe("RateLimited");
    expect(response.headers["retry-after"]).toBe("7");
  });

  it("should log rate_limited without the subject when the limiter trips", async () => {
    const redis = fakeRedis("ready", () => Promise.resolve([0, 1]));
    const log = logSink();
    const app = buildApp({ name: "log-deny", limit: 1, degrade: "fallback", redis: redis.client, logger: log.logger });

    await request(app).get("/limited");

    const warn = log.lines().find((line) => line.message === "rate_limited");
    expect(warn?.limiter).toBe("log-deny");
    expect(warn?.degraded).toBe(false);
    expect(log.lines().some((line) => line.message === "metric" && line.rate_limited === 1)).toBe(true);
    expect(log.text()).not.toContain(SUBJECT);
  });

  it("should use the in-process limiter at floor(limit / divisor) when Redis is not ready and degrade is fallback", async () => {
    const redis = fakeRedis("connecting", () => Promise.resolve([1, 0]));
    const now = 5_000_000;
    const app = buildApp({
      name: "fallback-floor",
      limit: 4,
      degrade: "fallback",
      redis: redis.client,
      logger: logSink().logger,
      fallbackDivisor: 2,
      now: () => now,
    });

    const first = await request(app).get("/limited");
    const second = await request(app).get("/limited");
    const third = await request(app).get("/limited");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(redis.command).not.toHaveBeenCalled();
  });

  it("should fall back when the Redis call exceeds 50 ms", async () => {
    const redis = fakeRedis(
      "ready",
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve([1, 0]);
          }, 120);
        }),
    );
    const log = logSink();
    const app = buildApp({
      name: "fallback-timeout",
      limit: 2,
      degrade: "fallback",
      redis: redis.client,
      logger: log.logger,
      now: () => 6_000_000,
    });

    const response = await request(app).get("/limited");

    expect(response.status).toBe(200);
    const degraded = log.lines().find((line) => line.message === "rate_limiter_degraded");
    expect(degraded?.mode).toBe("fallback");
  });

  it("should call next when Redis is unavailable and degrade is fail-open", async () => {
    const redis = fakeRedis("end", () => Promise.resolve([0, 9]));
    const app = buildApp({
      name: "fail-open",
      limit: 1,
      degrade: "fail-open",
      redis: redis.client,
      logger: logSink().logger,
      now: () => 7_000_000,
    });

    for (let i = 0; i < 5; i += 1) {
      const response = await request(app).get("/limited");
      expect(response.status).toBe(200);
    }
  });

  it("should emit rate_limiter_degraded at most once per minute per limiter", async () => {
    const redis = fakeRedis("end", () => Promise.resolve([1, 0]));
    const log = logSink();
    let now = 8_000_000;
    const app = buildApp({
      name: "degrade-throttle",
      limit: 10,
      degrade: "fail-open",
      redis: redis.client,
      logger: log.logger,
      now: () => now,
    });

    await request(app).get("/limited");
    now += 30_000;
    await request(app).get("/limited");

    expect(log.lines().filter((line) => line.message === "rate_limiter_degraded")).toHaveLength(1);

    now += 31_000;
    await request(app).get("/limited");

    expect(log.lines().filter((line) => line.message === "rate_limiter_degraded")).toHaveLength(2);
  });

  it("should use Redis again when it becomes ready", async () => {
    const redis = fakeRedis("end", () => Promise.resolve([1, 0]));
    const app = buildApp({
      name: "recovers",
      limit: 10,
      degrade: "fail-open",
      redis: redis.client,
      logger: logSink().logger,
      now: () => 9_000_000,
    });

    await request(app).get("/limited");
    expect(redis.command).not.toHaveBeenCalled();

    redis.setStatus("ready");
    const response = await request(app).get("/limited");

    expect(response.status).toBe(200);
    expect(redis.command).toHaveBeenCalledTimes(1);
  });
});
