import { AppError } from "../../../../src/lib/error/AppError";
import { HashQueueFull, Semaphore } from "../../../../src/lib/password/semaphore";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Semaphore", () => {
  it("should run at most max tasks at a time when more are submitted", async () => {
    const semaphore = new Semaphore(2, 10);
    const gates = [deferred(), deferred(), deferred()];
    let running = 0;
    let peak = 0;

    const runs = gates.map((gate) =>
      semaphore.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
      }),
    );

    await Promise.resolve();
    expect(peak).toBe(2);
    expect(semaphore.heldCount()).toBe(2);
    expect(semaphore.queueDepth()).toBe(1);

    for (const gate of gates) {
      gate.resolve();
    }
    await Promise.all(runs);
    expect(peak).toBe(2);
  });

  it("should reject immediately with RateLimited when the queue is full", async () => {
    const semaphore = new Semaphore(1, 1);
    const held = deferred();
    const queued = deferred();

    const first = semaphore.run(() => held.promise);
    const second = semaphore.run(() => queued.promise);

    await expect(semaphore.run(async () => undefined)).rejects.toBe(HashQueueFull);
    expect(HashQueueFull).toBeInstanceOf(AppError);
    expect(HashQueueFull).toMatchObject({ code: "RateLimited", status: 429, retryAfterSeconds: 1 });

    held.resolve();
    queued.resolve();
    await Promise.all([first, second]);
  });

  it("should release the slot when the task throws", async () => {
    const semaphore = new Semaphore(1, 0);

    await expect(
      semaphore.run(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    await expect(semaphore.run(async () => "after")).resolves.toBe("after");
    expect(semaphore.heldCount()).toBe(0);
  });

  it("should hand the released slot to the first waiter when a task finishes", async () => {
    const semaphore = new Semaphore(1, 5);
    const gate = deferred();
    const order: number[] = [];

    const first = semaphore.run(async () => {
      order.push(1);
      await gate.promise;
    });
    const second = semaphore.run(async () => {
      order.push(2);
    });
    const third = semaphore.run(async () => {
      order.push(3);
    });

    gate.resolve();
    await Promise.all([first, second, third]);

    expect(order).toEqual([1, 2, 3]);
  });
});
