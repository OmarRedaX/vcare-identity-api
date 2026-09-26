import type { Knex } from "knex";

/**
 * Runs `fn` inside a transaction that holds a transaction-scoped advisory lock, or returns `undefined`
 * without running it when another session holds the lock. Used by the worker's purge loop so two workers
 * never delete the same batch (spec §5.6). The lock is released by COMMIT/ROLLBACK, never leaked.
 */
export async function withAdvisoryXactLock<T>(
  db: Knex,
  key: bigint,
  fn: (trx: Knex.Transaction) => Promise<T>,
): Promise<T | undefined> {
  const trx = await db.transaction();
  try {
    const result = await trx.raw<{ rows: { locked: boolean }[] }>(
      "SELECT pg_try_advisory_xact_lock(?::bigint) AS locked",
      [key.toString()],
    );
    if (result.rows[0]?.locked !== true) {
      await trx.rollback();
      return undefined;
    }

    const value = await fn(trx);
    await trx.commit();
    return value;
  } catch (err) {
    await trx.rollback().catch(() => undefined);
    throw err;
  }
}
