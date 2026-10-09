import "reflect-metadata";
import { registerDependencies } from "./bootstrap";
import type { AuthMailService } from "./app/auth/service/auth-mail.service";
import type { PurgeService } from "./app/auth/service/purge.service";
import { env } from "./lib/config/env";
import { EnvRequirementError, requireWorkerConfig } from "./lib/config/requirements";
import { TOKENS } from "./lib/di/tokens";
import { db } from "./lib/knex/knex";
import { logger } from "./lib/logger/logger";
import { OutboxProcessor } from "./lib/outbox/outbox-processor";
import { redis } from "./lib/redis/redis";
import { runLoop } from "./lib/worker/run-loop";
import { withDeadline } from "./pkg/utils/promise";
import { toMs } from "./pkg/utils/time";
import type { LoopHandle } from "./lib/worker/types";
import type { ShutdownReason, WorkerHandle } from "./types";

/** Retention purges are cheap and need no urgency; ten minutes keeps the tables bounded (spec §5.6). */
const PURGE_INTERVAL_MS = toMs(10, "m");

/** Background work runs only here (ADR 0007), never inside an API request. */
export function startWorker(): Promise<WorkerHandle> {
  const scope = registerDependencies();

  // The worker's own environment set: email provider and OTP pepper, but never signing keys (spec §5.7).
  try {
    requireWorkerConfig(env);
  } catch (err) {
    if (err instanceof EnvRequirementError) {
      logger.error("invalid_environment", { keys: err.missingKeys });
      process.exit(1);
    }
    throw err;
  }

  const mail = scope.resolve<AuthMailService>(TOKENS.AuthMailService);
  const purges = scope.resolve<PurgeService>(TOKENS.PurgeService);

  const processor = new OutboxProcessor({
    db,
    logger,
    handlers: mail.handlers(),
    batchSize: env.WORKER_BATCH_SIZE,
    maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
  });

  const loops: LoopHandle[] = [
    runLoop({
      name: "outbox",
      intervalMs: env.WORKER_POLL_INTERVAL_MS,
      tick: (signal) => processor.tick(signal),
      logger,
    }),
    runLoop({
      name: "purge",
      intervalMs: PURGE_INTERVAL_MS,
      tick: async (signal) => {
        await purges.runAll(signal);
      },
      logger,
    }),
  ];

  logger.info("worker_started", {
    intervalMs: env.WORKER_POLL_INTERVAL_MS,
    purgeIntervalMs: PURGE_INTERVAL_MS,
    batchSize: env.WORKER_BATCH_SIZE,
  });

  let shutdownPromise: Promise<number> | undefined;

  const runShutdown = async (reason: ShutdownReason): Promise<number> => {
    logger.info("worker_stopping", { reason });

    let timer: NodeJS.Timeout | undefined;
    // Both loops finish their current tick and never start another.
    const stopped = await Promise.race([
      Promise.all(loops.map((loop) => loop.stop())).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, env.SHUTDOWN_TIMEOUT_MS);
      }),
    ]);
    if (timer) {
      clearTimeout(timer);
    }

    if (!stopped) {
      logger.error("worker_shutdown_timeout");
    }

    await withDeadline(db.destroy(), env.SHUTDOWN_TIMEOUT_MS);
    redis.disconnect();

    if (!stopped) {
      return 1;
    }
    return reason === "uncaughtException" || reason === "unhandledRejection" ? 1 : 0;
  };

  return Promise.resolve({
    shutdown(reason: ShutdownReason): Promise<number> {
      shutdownPromise ??= runShutdown(reason);
      return shutdownPromise;
    },
  });
}

if (require.main === module) {
  // Signal handlers are installed before the worker starts, so a SIGTERM that arrives right after
  // "worker_started" is logged still runs the graceful shutdown instead of killing the process outright.
  const exitAfterShutdown = (reason: ShutdownReason): void => {
    void booted.then((worker) => worker.shutdown(reason)).then((code) => {
      process.exit(code);
    });
  };

  process.on("SIGTERM", () => {
    exitAfterShutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    exitAfterShutdown("SIGINT");
  });
  process.on("uncaughtException", (err: Error) => {
    logger.error("uncaught_exception", { err });
    exitAfterShutdown("uncaughtException");
  });
  process.on("unhandledRejection", (err: unknown) => {
    logger.error("unhandled_rejection", { err });
    exitAfterShutdown("unhandledRejection");
  });

  const booted: Promise<WorkerHandle> = Promise.resolve().then(startWorker);
  booted.catch((err: unknown) => {
    logger.error("boot_failed", { err });
    process.exit(1);
  });
}
