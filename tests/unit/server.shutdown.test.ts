import type { EventEmitter } from "node:events";
import { captureLogs } from "../helpers/log-capture";

jest.mock("node:http", () => {
  /* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment */
  const { EventEmitter: Emitter } = require("node:events");
  // Express reads http.METHODS at import time, so the real module is kept and only createServer is replaced.
  const actual = jest.requireActual<Record<string, unknown>>("node:http");
  const servers: unknown[] = [];

  class FakeServer extends Emitter {
    keepAliveTimeout = 0;
    headersTimeout = 0;
    listenArgs: unknown[] = [];
    autoClose = true;
    onClose: (() => void) | undefined = undefined;
    closeIdleConnections = jest.fn();
    closeAllConnections = jest.fn();

    listen(...args: unknown[]): this {
      this.listenArgs = args;
      const callback = args[args.length - 1];
      if (typeof callback === "function") {
        (callback as () => void)();
      }
      return this;
    }

    close(callback?: () => void): this {
      this.onClose?.();
      if (this.autoClose && callback) {
        callback();
      }
      return this;
    }
  }

  return {
    ...actual,
    createServer: jest.fn(() => {
      const server = new FakeServer();
      servers.push(server);
      return server;
    }),
    __servers: servers,
    __reset: () => {
      servers.length = 0;
    },
  };
  /* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment */
});

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

import { env } from "../../src/lib/config/env";
import { db } from "../../src/lib/knex/knex";
import { lifecycle } from "../../src/lib/lifecycle/lifecycle";
import { redis } from "../../src/lib/redis/redis";
import { startServer } from "../../src/server";

interface MockServer extends EventEmitter {
  keepAliveTimeout: number;
  headersTimeout: number;
  listenArgs: unknown[];
  autoClose: boolean;
  onClose: (() => void) | undefined;
  closeIdleConnections: jest.Mock;
  closeAllConnections: jest.Mock;
}

interface HttpMock {
  __servers: MockServer[];
  __reset: () => void;
}

const httpMock = jest.requireMock<HttpMock>("node:http");

/** Reads a jest mock off a mocked module without detaching a real method (unbound-method). */
function mockOf(target: unknown, method: string): jest.Mock {
  return (target as Record<string, jest.Mock>)[method] as jest.Mock;
}

const destroy = mockOf(db, "destroy");
const quit = mockOf(redis, "quit");

function servers(): { publicServer: MockServer; internalServer: MockServer } {
  const [publicServer, internalServer] = httpMock.__servers;
  if (!publicServer || !internalServer) {
    throw new Error("expected two servers to be created");
  }
  return { publicServer, internalServer };
}

beforeEach(() => {
  httpMock.__reset();
  destroy.mockImplementation(() => Promise.resolve());
  quit.mockImplementation(() => Promise.resolve("OK"));
});

afterEach(() => {
  jest.useRealTimers();
});

describe("startServer", () => {
  it("should bind the internal listener to INTERNAL_HOST when starting", async () => {
    await startServer();
    const { publicServer, internalServer } = servers();

    expect(publicServer.listenArgs[0]).toBe(env.PORT);
    expect(publicServer.listenArgs).toHaveLength(2);
    expect(internalServer.listenArgs[0]).toBe(env.INTERNAL_PORT);
    expect(internalServer.listenArgs[1]).toBe(env.INTERNAL_HOST);
    expect(publicServer.keepAliveTimeout).toBe(65_000);
    expect(publicServer.headersTimeout).toBe(66_000);
  });

  it("should mark not-ready before closing the listeners", async () => {
    const server = await startServer();
    const { publicServer, internalServer } = servers();
    const order: string[] = [];
    publicServer.onClose = () => {
      order.push(lifecycle.isShuttingDown() ? "not-ready-already" : "still-ready");
    };
    internalServer.onClose = () => {
      order.push(lifecycle.isShuttingDown() ? "not-ready-already" : "still-ready");
    };

    await server.shutdown("SIGTERM");

    expect(order).toEqual(["not-ready-already", "not-ready-already"]);
    expect(lifecycle.isShuttingDown()).toBe(true);
  });

  it("should close both listeners before destroying knex and quitting Redis", async () => {
    const server = await startServer();
    const { publicServer, internalServer } = servers();
    const order: string[] = [];
    publicServer.onClose = () => order.push("close:public");
    internalServer.onClose = () => order.push("close:internal");
    destroy.mockImplementation(() => {
      order.push("db.destroy");
      return Promise.resolve();
    });
    quit.mockImplementation(() => {
      order.push("redis.quit");
      return Promise.resolve("OK");
    });

    await server.shutdown("SIGTERM");

    expect(order).toEqual(["close:public", "close:internal", "db.destroy", "redis.quit"]);
    expect(publicServer.closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(internalServer.closeIdleConnections).toHaveBeenCalledTimes(1);
  });

  it("should resolve 0 when the drain completes before the deadline", async () => {
    const server = await startServer();

    await expect(server.shutdown("SIGTERM")).resolves.toBe(0);
  });

  it("should resolve 1 and log shutdown_timeout with the unfinished count when the deadline passes", async () => {
    const server = await startServer();
    const { publicServer, internalServer } = servers();
    publicServer.autoClose = false;
    internalServer.autoClose = false;

    const capture = captureLogs();
    jest.useFakeTimers();
    try {
      const pending = server.shutdown("SIGTERM");
      await jest.advanceTimersByTimeAsync(env.SHUTDOWN_TIMEOUT_MS + 10);

      await expect(pending).resolves.toBe(1);
      const line = capture.lines().find((entry) => entry.message === "shutdown_timeout");
      expect(line?.level).toBe("error");
      expect(typeof line?.unfinishedRequests).toBe("number");
      expect(publicServer.closeAllConnections).toHaveBeenCalledTimes(1);
      expect(internalServer.closeAllConnections).toHaveBeenCalledTimes(1);
    } finally {
      capture.restore();
    }
  });

  it("should run the sequence once when two signals arrive", async () => {
    const server = await startServer();

    const [first, second] = await Promise.all([server.shutdown("SIGTERM"), server.shutdown("SIGINT")]);

    expect(first).toBe(0);
    expect(second).toBe(0);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("should resolve 1 when the reason is uncaughtException", async () => {
    const server = await startServer();

    await expect(server.shutdown("uncaughtException")).resolves.toBe(1);
  });

  it("should disconnect Redis when quit fails during shutdown", async () => {
    const server = await startServer();
    quit.mockImplementation(() => Promise.reject(new Error("connection lost")));

    await server.shutdown("SIGTERM");

    expect(mockOf(redis, "disconnect")).toHaveBeenCalled();
  });
});
