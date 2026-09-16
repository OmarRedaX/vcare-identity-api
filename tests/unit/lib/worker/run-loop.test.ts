import { Logger } from "../../../../src/lib/logger/logger";
import { runLoop } from "../../../../src/lib/worker/run-loop";

interface Harness {
  logger: Logger;
  lines: () => Record<string, unknown>[];
}

function logSink(): Harness {
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
  };
}

describe("runLoop", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("should run ticks sequentially separated by the interval", async () => {
    jest.useFakeTimers();
    const { logger } = logSink();
    let running = 0;
    let ticks = 0;
    const loop = runLoop({
      name: "test",
      intervalMs: 1000,
      logger,
      tick: () => {
        running += 1;
        expect(running).toBe(1);
        ticks += 1;
        running -= 1;
        return Promise.resolve();
      },
    });

    await jest.advanceTimersByTimeAsync(0);
    expect(ticks).toBe(1);

    await jest.advanceTimersByTimeAsync(1000);
    expect(ticks).toBe(2);

    await jest.advanceTimersByTimeAsync(1000);
    expect(ticks).toBe(3);

    await loop.stop();
  });

  it("should keep looping and log worker_tick_failed when a tick throws", async () => {
    jest.useFakeTimers();
    const { logger, lines } = logSink();
    let ticks = 0;
    const loop = runLoop({
      name: "test",
      intervalMs: 500,
      logger,
      tick: () => {
        ticks += 1;
        return ticks === 1 ? Promise.reject(new Error("tick failed")) : Promise.resolve();
      },
    });

    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(500);

    expect(ticks).toBe(2);
    const line = lines().find((entry) => entry.message === "worker_tick_failed");
    expect(line?.level).toBe("error");
    expect(line?.loop).toBe("test");

    await loop.stop();
  });

  it("should let the current tick finish when stop is called", async () => {
    const { logger } = logSink();
    let finished = false;
    let started = false;
    const loop = runLoop({
      name: "test",
      intervalMs: 50,
      logger,
      tick: () =>
        new Promise<void>((resolve) => {
          started = true;
          setTimeout(() => {
            finished = true;
            resolve();
          }, 30);
        }),
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toBe(true);

    await loop.stop();

    expect(finished).toBe(true);
  });

  it("should not start another tick after stop", async () => {
    const { logger } = logSink();
    let ticks = 0;
    const loop = runLoop({
      name: "test",
      intervalMs: 5,
      logger,
      tick: () => {
        ticks += 1;
        return Promise.resolve();
      },
    });

    await loop.stop();
    const after = ticks;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(ticks).toBe(after);
  });

  it("should return the same promise when stop is called twice", async () => {
    const { logger } = logSink();
    const loop = runLoop({
      name: "test",
      intervalMs: 5,
      logger,
      tick: () => Promise.resolve(),
    });

    const first = loop.stop();
    const second = loop.stop();

    expect(first).toBe(second);
    await first;
  });
});
