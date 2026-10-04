import { CircuitBreaker } from "../../../../src/lib/redis/circuit-breaker";

const OPTIONS = { failureThreshold: 3, windowMs: 10_000, cooldownMs: 15_000 };

function setup() {
  const clock = { now: 1_000_000 };
  const logger = { info: jest.fn(), warn: jest.fn(), metric: jest.fn() };
  const breaker = new CircuitBreaker(OPTIONS, { now: () => clock.now, logger });
  return { clock, logger, breaker };
}

function trip(breaker: CircuitBreaker): void {
  breaker.recordFailure();
  breaker.recordFailure();
  breaker.recordFailure();
}

describe("CircuitBreaker", () => {
  it("should stay closed when failures are below the threshold", () => {
    const { breaker } = setup();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("closed");
    expect(breaker.allow()).toBe(true);
  });

  it("should open and refuse calls when the threshold is reached", () => {
    const { breaker, logger } = setup();
    trip(breaker);
    expect(breaker.getState()).toBe("open");
    expect(breaker.allow()).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith("redis_breaker_open", { cooldownMs: 15_000 });
  });

  it("should reset the failure streak when a call succeeds in between", () => {
    const { breaker } = setup();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("closed");
  });

  it("should restart the streak when failures are further apart than the window", () => {
    const { breaker, clock } = setup();
    breaker.recordFailure();
    breaker.recordFailure();
    clock.now += 10_001;
    breaker.recordFailure();
    expect(breaker.getState()).toBe("closed");
  });

  it("should refuse calls until the cool-down elapses and then admit exactly one probe", () => {
    const { breaker, clock } = setup();
    trip(breaker);
    clock.now += 14_999;
    expect(breaker.allow()).toBe(false);
    clock.now += 1;
    expect(breaker.allow()).toBe(true);
    expect(breaker.getState()).toBe("half_open");
    expect(breaker.allow()).toBe(false);
  });

  it("should close when the half-open probe succeeds", () => {
    const { breaker, clock, logger } = setup();
    trip(breaker);
    clock.now += 15_000;
    breaker.allow();
    breaker.recordSuccess();
    expect(breaker.getState()).toBe("closed");
    expect(breaker.allow()).toBe(true);
    expect(logger.info).toHaveBeenCalledWith("redis_breaker_closed");
  });

  it("should re-open for a fresh cool-down when the half-open probe fails", () => {
    const { breaker, clock } = setup();
    trip(breaker);
    clock.now += 15_000;
    breaker.allow();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
    clock.now += 14_999;
    expect(breaker.allow()).toBe(false);
    clock.now += 1;
    expect(breaker.allow()).toBe(true);
  });

  it("should admit a replacement probe when the first probe never reports", () => {
    const { breaker, clock } = setup();
    trip(breaker);
    clock.now += 15_000;
    expect(breaker.allow()).toBe(true);
    clock.now += 15_000;
    expect(breaker.allow()).toBe(true);
  });

  it("should ignore late failure reports while open", () => {
    const { breaker, clock } = setup();
    trip(breaker);
    breaker.recordFailure();
    clock.now += 15_000;
    expect(breaker.allow()).toBe(true);
  });
});
