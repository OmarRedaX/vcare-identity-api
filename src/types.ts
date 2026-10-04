import type http from "node:http";
import type { Router } from "express";
import type Redis from "ioredis";
import type { Knex } from "knex";
import type { DependencyContainer } from "tsyringe";
import type { SigningKeySet } from "./lib/auth/types";
import type { EmailPort } from "./lib/email/types";
import type { Lifecycle } from "./lib/lifecycle/lifecycle";
import type { Logger } from "./lib/logger/logger";
import type { Clock } from "./lib/time/types";

/** Tests replace infrastructure singletons; production passes nothing. */
export interface DependencyOverrides {
  db?: Knex;
  /** Readiness-probe connection; defaults to `db` when only `db` is overridden. */
  probeDb?: Knex;
  redis?: Redis;
  logger?: Logger;
  lifecycle?: Lifecycle;
  /** Lets tests control "now" without faking the process clock. */
  clock?: Clock;
  /** Pre-loaded key set, so tests need not put key material in the environment. */
  signingKeys?: SigningKeySet;
  /** The only mock integration tests may use (CLAUDE.md -> Testing policy). */
  emailPort?: EmailPort;
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
