import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { inflightTracker } from "../../../../src/lib/lifecycle/inflight";
import { Lifecycle } from "../../../../src/lib/lifecycle/lifecycle";

function fakeResponse(): EventEmitter & Response {
  return new EventEmitter() as EventEmitter & Response;
}

describe("Lifecycle", () => {
  it("should report shutting down after markShuttingDown is called", () => {
    const lifecycle = new Lifecycle();

    expect(lifecycle.isShuttingDown()).toBe(false);
    lifecycle.markShuttingDown();
    lifecycle.markShuttingDown();
    expect(lifecycle.isShuttingDown()).toBe(true);
  });

  it("should never report a negative in-flight count", () => {
    const lifecycle = new Lifecycle();

    lifecycle.requestEnded();
    lifecycle.requestEnded();

    expect(lifecycle.inflightCount()).toBe(0);
  });
});

describe("inflightTracker", () => {
  it("should count a request once when both finish and close fire", () => {
    const lifecycle = new Lifecycle();
    const handler = inflightTracker(lifecycle);
    const res = fakeResponse();
    const next = jest.fn();

    handler({} as Request, res, next);
    expect(lifecycle.inflightCount()).toBe(1);
    expect(next).toHaveBeenCalledTimes(1);

    res.emit("finish");
    res.emit("close");

    expect(lifecycle.inflightCount()).toBe(0);
  });

  it("should count concurrent requests when several are in flight", () => {
    const lifecycle = new Lifecycle();
    const handler = inflightTracker(lifecycle);
    const first = fakeResponse();
    const second = fakeResponse();

    handler({} as Request, first, jest.fn());
    handler({} as Request, second, jest.fn());
    expect(lifecycle.inflightCount()).toBe(2);

    first.emit("close");
    expect(lifecycle.inflightCount()).toBe(1);
  });
});
