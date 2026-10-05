import type { Express, Router } from "express";
import type Redis from "ioredis";
import type { DegradeMode } from "../../src/lib/rate-limit/types";
import type { Logger } from "../../src/lib/logger/logger";
import type { LogLevel } from "../../src/lib/logger/types";
import type { DependencyOverrides } from "../../src/types";

export interface BuildTestAppsOptions {
  extraApiRouter?: Router;
  extraInternalRouter?: Router;
  overrides?: DependencyOverrides;
}

export interface TestApps {
  publicApp: Express;
  internalApp: Express;
}

export interface LogCapture {
  lines(): Record<string, unknown>[];
  text(): string;
  restore(): void;
}

export interface CaptureLogsOptions {
  level?: LogLevel;
  logger?: Logger;
}

export interface TestRouterDeps {
  redis?: Redis;
  logger?: Logger;
  degrade?: DegradeMode;
}

/** Every exported function of a jest.mock()ed module, typed as a jest.Mock (unit tests only). */
export type MockedModule<T> = { [K in keyof T]: jest.Mock };

/** Options for `seedUser` — everything defaults to a synthetic, fully valid patient account. */
export interface SeedUserOptions {
  email?: string;
  password?: string;
  passwordHash?: string;
  role?: import("../../src/lib/rbac/types").Role;
  status?: import("../../src/lib/rbac/types").AccountStatus;
  fullName?: string;
  phone?: string | null;
  timezone?: string;
  locale?: string;
}

/** A clock the test moves by hand (spec §2.6: tests control "now" without faking Postgres). */
export interface MutableClock {
  clock: import("../../src/lib/time/types").Clock;
  advance(ms: number): void;
  set(next: Date): void;
}
