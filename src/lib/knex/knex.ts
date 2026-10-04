import knex, { type Knex } from "knex";
import { env } from "../config/env";
import { logger } from "../logger/logger";
import { buildKnexConfig } from "./knexfile";

/** Request paths fail fast; migrations use migrationConfig (no timeout). */
export const STATEMENT_TIMEOUT_MS = 2000;

/** The readiness probe's budget: shorter than the request statement timeout. */
export const PROBE_STATEMENT_TIMEOUT_MS = 1000;

export const db: Knex = knex(
  buildKnexConfig({
    databaseUrl: env.DATABASE_URL,
    poolMax: env.DATABASE_POOL_MAX,
    statementTimeoutMs: STATEMENT_TIMEOUT_MS,
    logger,
  }),
);

/**
 * A dedicated single-connection pool for the readiness probe, so pool saturation of `db` is never read as
 * "Postgres is down" (spec F3, ADR 0014). It connects lazily on first use.
 */
export const probeDb: Knex = knex(
  buildKnexConfig({
    databaseUrl: env.DATABASE_URL,
    poolMax: 1,
    statementTimeoutMs: PROBE_STATEMENT_TIMEOUT_MS,
    logger,
  }),
);
