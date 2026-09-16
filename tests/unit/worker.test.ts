jest.mock("../../src/lib/knex/knex", () => ({
  db: { destroy: jest.fn(() => Promise.resolve()) },
}));

jest.mock("../../src/lib/redis/redis", () => ({
  redis: { quit: jest.fn(() => Promise.resolve("OK")), disconnect: jest.fn(), status: "ready" },
  connectRedis: jest.fn(),
  createRedis: jest.fn(),
  isRedisReady: () => false,
  pingRedis: jest.fn(() => Promise.resolve("down")),
  withTimeout: jest.fn(),
}));

jest.mock("../../src/lib/worker/run-loop", () => ({
  runLoop: jest.fn(() => ({ stopped: Promise.resolve(), stop: jest.fn(() => Promise.resolve()) })),
}));

import { captureLogs } from "../helpers/log-capture";
import { env } from "../../src/lib/config/env";
import { db } from "../../src/lib/knex/knex";
import { redis } from "../../src/lib/redis/redis";
import { runLoop } from "../../src/lib/worker/run-loop";
import { startWorker } from "../../src/worker";

/** Reads a jest mock off a mocked module without detaching a real method (unbound-method). */
function mockOf(target: unknown, method: string): jest.Mock {
  return (target as Record<string, jest.Mock>)[method] as jest.Mock;
}

const runLoopMock = runLoop as unknown as jest.Mock;
const destroy = mockOf(db, "destroy");

beforeEach(() => {
  destroy.mockImplementation(() => Promise.resolve());
  runLoopMock.mockImplementation(() => ({
    stopped: Promise.resolve(),
    stop: jest.fn(() => Promise.resolve()),
  }));
});

afterEach(() => {
  jest.useRealTimers();
});

describe("startWorker", () => {
  it("should stop the loop then destroy knex when SIGTERM arrives", async () => {
    const order: string[] = [];
    const stop = jest.fn(() => {
      order.push("loop.stop");
      return Promise.resolve();
    });
    runLoopMock.mockImplementation(() => ({ stopped: Promise.resolve(), stop }));
    destroy.mockImplementation(() => {
      order.push("db.destroy");
      return Promise.resolve();
    });

    const worker = await startWorker();
    const code = await worker.shutdown("SIGTERM");

    expect(code).toBe(0);
    expect(order).toEqual(["loop.stop", "db.destroy"]);
    expect(mockOf(redis, "disconnect")).toHaveBeenCalled();
    expect(runLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "worker", intervalMs: env.WORKER_POLL_INTERVAL_MS }),
    );
  });

  it("should run the sequence once when two signals arrive", async () => {
    const worker = await startWorker();

    await Promise.all([worker.shutdown("SIGTERM"), worker.shutdown("SIGINT")]);

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("should resolve 1 when the loop does not stop before the deadline", async () => {
    runLoopMock.mockImplementation(() => ({
      stopped: new Promise<void>(() => undefined),
      stop: jest.fn(() => new Promise<void>(() => undefined)),
    }));

    const capture = captureLogs();
    jest.useFakeTimers();
    try {
      const worker = await startWorker();
      const pending = worker.shutdown("SIGTERM");
      await jest.advanceTimersByTimeAsync(env.SHUTDOWN_TIMEOUT_MS + 10);

      await expect(pending).resolves.toBe(1);
      expect(capture.lines().some((line) => line.message === "worker_shutdown_timeout")).toBe(true);
    } finally {
      capture.restore();
    }
  });
});
