import { InProcessLimiter } from "../../../../src/lib/rate-limit/in-process-limiter";

describe("InProcessLimiter", () => {
  it("should allow up to the limit within the window and deny the next hit", () => {
    const limiter = new InProcessLimiter();
    const now = 1_000_000;

    expect(limiter.hit("rl:test:a", 2, 1000, now).allowed).toBe(true);
    expect(limiter.hit("rl:test:a", 2, 1000, now + 10).allowed).toBe(true);

    const denied = limiter.hit("rl:test:a", 2, 1000, now + 20);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("should allow again when the oldest hit leaves the window", () => {
    const limiter = new InProcessLimiter();
    const now = 2_000_000;

    limiter.hit("rl:test:b", 1, 1000, now);
    expect(limiter.hit("rl:test:b", 1, 1000, now + 500).allowed).toBe(false);
    expect(limiter.hit("rl:test:b", 1, 1000, now + 1500).allowed).toBe(true);
  });

  it("should evict the oldest key when maxKeys is reached", () => {
    const limiter = new InProcessLimiter(2);
    const now = 3_000_000;

    limiter.hit("first", 1, 60_000, now);
    limiter.hit("second", 1, 60_000, now);
    limiter.hit("third", 1, 60_000, now);

    // The newest key is still tracked and denied; the evicted oldest key starts over.
    expect(limiter.hit("third", 1, 60_000, now + 1).allowed).toBe(false);
    expect(limiter.hit("first", 1, 60_000, now + 1).allowed).toBe(true);
  });
});
