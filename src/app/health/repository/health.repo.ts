import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";

/** The readiness probe's only query (spec §11.5: nothing to EXPLAIN). */
export async function pingDatabase(conn: Knex = db): Promise<void> {
  await conn.raw("SELECT 1");
}
