import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { Logger } from "../../../../src/lib/logger/logger";
import { requestLogger } from "../../../../src/lib/logger/request-logger";

interface Harness {
  lines: () => Record<string, unknown>[];
  res: EventEmitter & Response;
}

function run(options: { routePattern?: string; status: number }): Harness {
  const written: string[] = [];
  const log = new Logger({
    service: "identity-service",
    level: "debug",
    production: false,
    sink: (line) => {
      written.push(line);
    },
  });

  const res = new EventEmitter() as EventEmitter & Response;
  (res as unknown as { locals: Record<string, unknown> }).locals =
    options.routePattern === undefined ? {} : { routePattern: options.routePattern };
  (res as unknown as { statusCode: number }).statusCode = options.status;

  const req = {
    method: "GET",
    url: "/api/things?secret=fixture-query",
    originalUrl: "/api/things?secret=fixture-query",
    headers: { authorization: "Bearer fixture-token" },
  } as unknown as Request;

  requestLogger(log)(req, res, jest.fn());

  return {
    res,
    lines: () =>
      written
        .join("")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("requestLogger", () => {
  it("should log route pattern status and durationMs when the response finishes", () => {
    const { res, lines } = run({ routePattern: "/api/things", status: 201 });

    res.emit("finish");

    const line = lines()[0] ?? {};
    expect(line.message).toBe("request_completed");
    expect(line.level).toBe("info");
    expect(line.method).toBe("GET");
    expect(line.route).toBe("/api/things");
    expect(line.status).toBe(201);
    expect(typeof line.durationMs).toBe("number");
  });

  it("should never log the url query string or headers when the response finishes", () => {
    const { res, lines } = run({ routePattern: "/api/things", status: 200 });

    res.emit("finish");

    const serialized = JSON.stringify(lines());
    expect(serialized).not.toContain("fixture-query");
    expect(serialized).not.toContain("fixture-token");
    expect(serialized).not.toContain("?");
  });

  it("should log unmatched as route when no route was captured", () => {
    const { res, lines } = run({ status: 404 });

    res.emit("finish");

    expect(lines()[0]?.route).toBe("unmatched");
  });

  it("should log at error level when the status is 500 or more", () => {
    const { res, lines } = run({ routePattern: "/api/things", status: 500 });

    res.emit("finish");

    expect(lines()[0]?.level).toBe("error");
  });

  it("should skip health routes when the status is below 500", () => {
    const ready = run({ routePattern: "/api/health/ready", status: 200 });
    ready.res.emit("finish");
    expect(ready.lines()).toHaveLength(0);

    const internal = run({ routePattern: "/internal/health/live", status: 200 });
    internal.res.emit("finish");
    expect(internal.lines()).toHaveLength(0);
  });

  it("should log a failing health route when the status is 500 or more", () => {
    const { res, lines } = run({ routePattern: "/api/health/ready", status: 500 });

    res.emit("finish");

    expect(lines()).toHaveLength(1);
  });

  it("should log status 499 when the client closes before finish", () => {
    const { res, lines } = run({ routePattern: "/api/things", status: 200 });

    res.emit("close");

    expect(lines()[0]?.status).toBe(499);
  });

  it("should log once when both finish and close fire", () => {
    const { res, lines } = run({ routePattern: "/api/things", status: 200 });

    res.emit("finish");
    res.emit("close");

    expect(lines()).toHaveLength(1);
  });
});
