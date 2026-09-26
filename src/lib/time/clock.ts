import type { Clock } from "./types";

/** Registered as TOKENS.Clock; tests override it through `registerDependencies({ clock })`. */
export const systemClock: Clock = {
  now(): Date {
    return new Date();
  },
};
