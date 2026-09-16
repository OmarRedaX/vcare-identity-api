import type Redis from "ioredis";
import type { Knex } from "knex";
import { HealthService } from "../../../../src/app/health/service/health.service";
import { Lifecycle } from "../../../../src/lib/lifecycle/lifecycle";
import { Logger } from "../../../../src/lib/logger/logger";

interface Harness {
  service: HealthService;
  lifecycle: Lifecycle;
  lines: () => Record<string, unknown>[];
}

function build(options: {
  ping?: () => Promise<unknown>;
  redisStatus?: string;
  redisPing?: () => Promise<string>;
}): Harness {
  const written: string[] = [];
  const logger = new Logger({
    service: "identity-service",
    level: "debug",
    production: false,
    sink: (line) => {
      written.push(line);
    },
  });

  const db = { raw: jest.fn(options.ping ?? (() => Promise.resolve({ rows: [] }))) } as unknown as Knex;
  const redis = {
    status: options.redisStatus ?? "ready",
    ping: options.redisPing ?? (() => Promise.resolve("PONG")),
  } as unknown as Redis;
  const lifecycle = new Lifecycle();

  return {
    service: new HealthService(db, redis, lifecycle, logger),
    lifecycle,
    lines: () =>
      written
        .join("")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("HealthService.readiness", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("should report 200 ok when the database and Redis are up", async () => {
    const { service } = build({});

    const result = await service.readiness();

    expect(result.httpStatus).toBe(200);
    expect(result.body).toEqual({ status: "ok", checks: { database: "up", redis: "up" } });
  });

  it("should report 200 degraded when Redis is down", async () => {
    const { service } = build({ redisStatus: "end" });

    const result = await service.readiness();

    expect(result.httpStatus).toBe(200);
    expect(result.body).toEqual({ status: "degraded", checks: { database: "up", redis: "down" } });
  });

  it("should report 503 down when the database is down", async () => {
    const { service, lines } = build({ ping: () => Promise.reject(new Error("ECONNREFUSED")) });

    const result = await service.readiness();

    expect(result.httpStatus).toBe(503);
    expect(result.body).toEqual({ status: "down", checks: { database: "down", redis: "up" } });
    const warn = lines().find((line) => line.message === "readiness_failed");
    expect(warn?.level).toBe("warn");
    expect(warn?.shuttingDown).toBe(false);
  });

  it("should mark the database down when SELECT 1 exceeds 500 ms", async () => {
    jest.useFakeTimers();
    const { service } = build({ ping: () => new Promise(() => undefined) });

    const pending = service.readiness();
    await jest.advanceTimersByTimeAsync(600);
    const result = await pending;

    expect(result.httpStatus).toBe(503);
    expect(result.body.checks.database).toBe("down");
  });

  it("should report 503 down when shutting down even if dependencies are up", async () => {
    const { service, lifecycle, lines } = build({});
    lifecycle.markShuttingDown();

    const result = await service.readiness();

    expect(result.httpStatus).toBe(503);
    expect(result.body).toEqual({ status: "down", checks: { database: "up", redis: "up" } });
    expect(lines().find((line) => line.message === "readiness_failed")?.shuttingDown).toBe(true);
  });
});

describe("HealthService.liveness", () => {
  it("should report liveness ok when shutting down", () => {
    const { service, lifecycle } = build({});
    lifecycle.markShuttingDown();

    expect(service.liveness()).toEqual({ status: "ok" });
  });

  it("should check no dependency when liveness is called", () => {
    const { service } = build({ ping: () => Promise.reject(new Error("db is gone")) });

    expect(service.liveness()).toEqual({ status: "ok" });
  });
});
