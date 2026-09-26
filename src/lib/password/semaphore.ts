import { RateLimited } from "../error/errors";

/**
 * Bounds concurrent argon2 work (CLAUDE.md -> Security rules: "a full queue returns 429 RateLimited, never
 * an unbounded wait"). FIFO queue; a released slot is handed to the next waiter, so `max` is never exceeded.
 */
export const HashQueueFull = RateLimited.withRetryAfter(1);

export class Semaphore {
  private readonly max: number;
  private readonly queueMax: number;
  private held = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(max: number, queueMax: number) {
    this.max = Math.max(1, max);
    this.queueMax = Math.max(0, queueMax);
  }

  queueDepth(): number {
    return this.waiting.length;
  }

  heldCount(): number {
    return this.held;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.held < this.max) {
      this.held += 1;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.queueMax) {
      return Promise.reject(HashQueueFull);
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      // The slot passes straight to the waiter; `held` stays as it is.
      next();
      return;
    }
    this.held -= 1;
  }
}
