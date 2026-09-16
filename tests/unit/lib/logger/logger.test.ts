import { Logger } from "../../../../src/lib/logger/logger";
import type { LogLevel } from "../../../../src/lib/logger/types";
import { requestContext } from "../../../../src/lib/request-id/context";

interface Harness {
  logger: Logger;
  lines: () => Record<string, unknown>[];
}

function harness(level: LogLevel = "debug", production = false): Harness {
  const written: string[] = [];
  const logger = new Logger({
    service: "identity-service",
    level,
    production,
    sink: (line) => {
      written.push(line);
    },
  });

  return {
    logger,
    lines: () =>
      written
        .join("")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("Logger", () => {
  it("should write one JSON line with level message timestamp and service when logging", () => {
    const { logger, lines } = harness();

    logger.info("request_completed", { route: "/api/health/ready", status: 200 });

    const written = lines();
    expect(written).toHaveLength(1);
    const line = written[0] ?? {};
    expect(line.level).toBe("info");
    expect(line.message).toBe("request_completed");
    expect(line.service).toBe("identity-service");
    expect(typeof line.timestamp).toBe("string");
    expect(new Date(String(line.timestamp)).toISOString()).toBe(line.timestamp);
    expect(line.route).toBe("/api/health/ready");
    expect(line.status).toBe(200);
  });

  it("should include requestId when called inside a request context", () => {
    const { logger, lines } = harness();

    requestContext.run({ requestId: "7f1c0a2e-0000-4000-8000-000000000001", userId: 7 }, () => {
      logger.warn("something_happened");
    });

    const line = lines()[0] ?? {};
    expect(line.requestId).toBe("7f1c0a2e-0000-4000-8000-000000000001");
    expect(line.userId).toBe(7);
  });

  it("should drop debug lines when the level is info", () => {
    const { logger, lines } = harness("info");

    logger.debug("noise");
    logger.info("kept");

    expect(lines().map((line) => line.message)).toEqual(["kept"]);
  });

  it("should drop debug lines when production is true", () => {
    const { logger, lines } = harness("debug", true);

    logger.debug("noise");

    expect(lines()).toHaveLength(0);
  });

  it("should not let fields override reserved keys", () => {
    const { logger, lines } = harness();

    logger.info("real_message", {
      level: "debug",
      message: "spoofed",
      timestamp: "spoofed",
      service: "spoofed",
    });

    const line = lines()[0] ?? {};
    expect(line.level).toBe("info");
    expect(line.message).toBe("real_message");
    expect(line.service).toBe("identity-service");
    expect(line.timestamp).not.toBe("spoofed");
  });

  it("should redact listed keys when they are passed as fields", () => {
    const { logger, lines } = harness();

    logger.info("login_attempt", { email: "person@example.test", password: "fixture-password" });

    const line = lines()[0] ?? {};
    expect(line.email).toBe("[REDACTED]");
    expect(line.password).toBe("[REDACTED]");
  });

  it("should write an EMF metric line when metric is called", () => {
    const { logger, lines } = harness("error");

    logger.metric("rate_limited", 1, "Count", { limiter: "login" });

    const line = lines()[0] ?? {};
    expect(line.message).toBe("metric");
    expect(line.rate_limited).toBe(1);
    expect(line.limiter).toBe("login");
    const aws = line._aws as { CloudWatchMetrics: { Namespace: string; Dimensions: string[][]; Metrics: { Name: string; Unit: string }[] }[] };
    expect(aws.CloudWatchMetrics[0]?.Namespace).toBe("vcare/identity-service");
    expect(aws.CloudWatchMetrics[0]?.Dimensions).toEqual([["limiter"]]);
    expect(aws.CloudWatchMetrics[0]?.Metrics).toEqual([{ Name: "rate_limited", Unit: "Count" }]);
  });

  it("should not throw when fields contain a circular reference", () => {
    const { logger, lines } = harness();
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;

    expect(() => {
      logger.error("circular_fields", circular);
    }).not.toThrow();
    expect(lines()[0]?.self).toBe("[Circular]");
  });

  it("should raise the threshold when setLevel is called", () => {
    const { logger, lines } = harness("debug");

    logger.setLevel("error");
    logger.warn("dropped");
    logger.error("kept");

    expect(lines().map((line) => line.message)).toEqual(["kept"]);
  });
});
