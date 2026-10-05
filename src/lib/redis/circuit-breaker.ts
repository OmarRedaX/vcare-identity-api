import type { BreakerState, CircuitBreakerDeps, CircuitBreakerOptions } from "./types";

/**
 * Per-client breaker for a connected-but-unresponsive Redis (ADR 0008 follow-up). Redis stays Tier 2: an open
 * breaker only makes callers take their existing degraded path immediately; it never fails a request or readiness.
 *
 * closed -> (N consecutive failures within the window) -> open -> (cooldown elapsed) -> half_open
 * half_open admits exactly one probe: success -> closed, failure -> open again for a fresh cooldown.
 */
export class CircuitBreaker {
  private state: BreakerState = "closed";
  private failures = 0;
  private streakStartedAt = 0;
  private openedAt = 0;
  private probeStartedAt = 0;

  constructor(
    private readonly options: CircuitBreakerOptions,
    private readonly deps: CircuitBreakerDeps,
  ) {}

  getState(): BreakerState {
    return this.state;
  }

  /** True when the caller may issue a Redis command. In half_open only the single probe is admitted. */
  allow(): boolean {
    const now = this.deps.now();
    if (this.state === "closed") {
      return true;
    }
    if (this.state === "open") {
      if (now - this.openedAt < this.options.cooldownMs) {
        return false;
      }
      this.state = "half_open";
      this.probeStartedAt = now;
      this.deps.logger.info("redis_breaker_half_open");
      return true;
    }
    // half_open: a probe whose outcome was never reported (caller crashed) is replaced after one cooldown.
    if (now - this.probeStartedAt >= this.options.cooldownMs) {
      this.probeStartedAt = now;
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    if (this.state === "half_open") {
      this.state = "closed";
      this.deps.logger.info("redis_breaker_closed");
      this.deps.logger.metric("redis_breaker_closed", 1, "Count");
    }
    this.failures = 0;
  }

  recordFailure(): void {
    const now = this.deps.now();
    if (this.state === "half_open") {
      this.trip(now);
      return;
    }
    if (this.state === "open") {
      return;
    }
    if (this.failures === 0 || now - this.streakStartedAt > this.options.windowMs) {
      this.failures = 0;
      this.streakStartedAt = now;
    }
    this.failures += 1;
    if (this.failures >= this.options.failureThreshold) {
      this.trip(now);
    }
  }

  private trip(now: number): void {
    this.state = "open";
    this.openedAt = now;
    this.failures = 0;
    this.deps.logger.warn("redis_breaker_open", { cooldownMs: this.options.cooldownMs });
    this.deps.logger.metric("redis_breaker_open", 1, "Count");
  }
}
