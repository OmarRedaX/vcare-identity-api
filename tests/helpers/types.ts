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
