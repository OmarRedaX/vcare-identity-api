import type http from "node:http";
import type { Router } from "express";
import type Redis from "ioredis";
import type { Knex } from "knex";
import type { DependencyContainer } from "tsyringe";
import type { Lifecycle } from "./lib/lifecycle/lifecycle";
import type { Logger } from "./lib/logger/logger";

/** Tests replace infrastructure singletons; production passes nothing. */
export interface DependencyOverrides {
  db?: Knex;
  redis?: Redis;
  logger?: Logger;
  lifecycle?: Lifecycle;
}

export interface AppOptions {
  /** Test-only router mounted under /api. */
  extraApiRouter?: Router;
  /** Container to resolve controllers from (tests pass the child container from registerDependencies). */
  scope?: DependencyContainer;
}

export interface InternalAppOptions {
  /** Test-only router mounted under /internal. */
  extraInternalRouter?: Router;
  scope?: DependencyContainer;
}

export type ShutdownReason = "SIGTERM" | "SIGINT" | "uncaughtException" | "unhandledRejection";

export interface RunningServer {
  publicServer: http.Server;
  internalServer: http.Server;
  shutdown(reason: ShutdownReason): Promise<number>;
}

export interface WorkerHandle {
  shutdown(reason: ShutdownReason): Promise<number>;
}
