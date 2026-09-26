import type { Logger } from "../logger/logger";

/** The subset of Logger that Knex's own warnings and errors are routed through. */
export type KnexLogger = Pick<Logger, "debug" | "warn" | "error">;

export interface KnexOptions {
  databaseUrl: string;
  poolMax: number;
  statementTimeoutMs: number | null;
  logger?: KnexLogger;
}
