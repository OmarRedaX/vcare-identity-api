import type { RateLimitDecision } from "./types";

const DEFAULT_MAX_KEYS = 10_000;

/** Per-task fallback used when Redis is unavailable (ADR 0008). Insertion-ordered eviction. */
export class InProcessLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly maxKeys: number;

  constructor(maxKeys: number = DEFAULT_MAX_KEYS) {
    this.maxKeys = maxKeys;
  }

  hit(key: string, limit: number, windowMs: number, now: number): RateLimitDecision {
    const cutoff = now - windowMs;
    const existing = this.hits.get(key);
    const timestamps = (existing ?? []).filter((at) => at > cutoff);

    if (existing === undefined && this.hits.size >= this.maxKeys) {
      const oldestKey = this.hits.keys().next().value;
      if (oldestKey !== undefined) {
        this.hits.delete(oldestKey);
      }
    }

    if (timestamps.length >= limit) {
      this.hits.set(key, timestamps);
      const oldest = timestamps[0] ?? now;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
      };
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
