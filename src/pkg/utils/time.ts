import type { DurationUnit } from "./types";

/** Pure duration math — no clock, no env (CLAUDE.md -> Code style: never inline `Date.now() + n * 1000`). */
const UNIT_MS: Record<DurationUnit, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function toMs(amount: number, unit: DurationUnit): number {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new RangeError("amount must be a finite, non-negative number");
  }
  return amount * UNIT_MS[unit];
}

export function addTime(date: Date, amount: number, unit: DurationUnit): Date {
  return new Date(date.getTime() + toMs(amount, unit));
}

export function subtractTime(date: Date, amount: number, unit: DurationUnit): Date {
  return new Date(date.getTime() - toMs(amount, unit));
}

/** Inclusive of the instant itself: an expiry exactly at `now` has passed. */
export function isPast(date: Date, now: Date): boolean {
  return date.getTime() <= now.getTime();
}
