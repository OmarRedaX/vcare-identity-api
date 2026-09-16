import "reflect-metadata";
import { registerDependencies } from "./bootstrap";
import { env } from "./lib/config/env";
import { db } from "./lib/knex/knex";
import { logger } from "./lib/logger/logger";
import { redis } from "./lib/redis/redis";
import { runLoop } from "./lib/worker/run-loop";
import type { ShutdownReason, WorkerHandle } from "./types";

/** Background work runs only here (ADR 0007), never inside an API request. */
export function startWorker(): Promise<WorkerHandle> {
  registerDependencies();

  const loop = runLoop({
    name: "worker",
    intervalMs: env.WORKER_POLL_INTERVAL_MS,
    // Job handlers are registered here by the outbox module (ADR 0007).
    tick: async () => {
      await Promise.resolve();
    },
    logger,
  });

  logger.info("worker_started", { intervalMs: env.WORKER_POLL_INTERVAL_MS });

  let shutdownPromise: Promise<number> | undefined;

  const runShutdown = async (reason: ShutdownReason): Promise<number> => {
    logger.info("worker_stopping", { reason });

    let timer: NodeJS.Timeout | undefined;
    const stopped = await Promise.race([
      loop.stop().then(() => true),
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

    await db.destroy().catch(() => undefined);
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
  void startWorker().then((worker) => {
    const exitAfterShutdown = (reason: ShutdownReason): void => {
      void worker.shutdown(reason).then((code) => {
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
  });
}
