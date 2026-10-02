const BASE_SECONDS = 30;
const MAX_SECONDS = 3600;

/** 30 s, 1 m, 2 m, 4 m … capped at 1 h (spec §5.4). `attempts` is the count already made (>= 1). */
export function retryDelaySeconds(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 20));
  return Math.min(BASE_SECONDS * 2 ** exponent, MAX_SECONDS);
}
