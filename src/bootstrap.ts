import type { DependencyContainer } from "tsyringe";
import { HealthController } from "./app/health/controller/health.controller";
import { HealthService } from "./app/health/service/health.service";
import { env } from "./lib/config/env";
import { container as rootContainer } from "./lib/di/container";
import { TOKENS } from "./lib/di/tokens";
import { db } from "./lib/knex/knex";
import { lifecycle } from "./lib/lifecycle/lifecycle";
import { logger } from "./lib/logger/logger";
import { redis } from "./lib/redis/redis";
import type { DependencyOverrides } from "./types";

let rootRegistered = false;

/**
 * The only place that wires lib/ singletons and app/ classes into the container
 * (CLAUDE.md -> Folder structure and layering). Idempotent for the root container.
 */
export function registerDependencies(overrides?: DependencyOverrides): DependencyContainer {
  const hasOverrides = overrides !== undefined && Object.keys(overrides).length > 0;
  const scope = hasOverrides ? rootContainer.createChildContainer() : rootContainer;

  if (!hasOverrides && rootRegistered) {
    return scope;
  }

  scope.registerInstance(TOKENS.Env, env);
  scope.registerInstance(TOKENS.Logger, overrides?.logger ?? logger);
  scope.registerInstance(TOKENS.Db, overrides?.db ?? db);
  scope.registerInstance(TOKENS.Redis, overrides?.redis ?? redis);
  scope.registerInstance(TOKENS.Lifecycle, overrides?.lifecycle ?? lifecycle);

  scope.registerSingleton(TOKENS.HealthService, HealthService);
  scope.registerSingleton(TOKENS.HealthController, HealthController);

  if (!hasOverrides) {
    rootRegistered = true;
  }

  return scope;
}
