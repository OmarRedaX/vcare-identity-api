import knex, { type Knex } from "knex";
import { env } from "../config/env";
import { buildKnexConfig } from "./knexfile";

/** Request paths fail fast; migrations use migrationConfig (no timeout). */
export const STATEMENT_TIMEOUT_MS = 2000;

export const db: Knex = knex(
  buildKnexConfig({
    databaseUrl: env.DATABASE_URL,
    poolMax: env.DATABASE_POOL_MAX,
    statementTimeoutMs: STATEMENT_TIMEOUT_MS,
  }),
);
