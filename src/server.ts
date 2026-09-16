import "reflect-metadata";
import http from "node:http";
import { createApp } from "./app";
import { registerDependencies } from "./bootstrap";
import { createInternalApp } from "./internal-app";
import { env } from "./lib/config/env";
import { db } from "./lib/knex/knex";
import { lifecycle } from "./lib/lifecycle/lifecycle";
import { logger } from "./lib/logger/logger";
import { connectRedis, redis } from "./lib/redis/redis";
import type { RunningServer, ShutdownReason } from "./types";

const KEEP_ALIVE_TIMEOUT_MS = 65_000;
const HEADERS_TIMEOUT_MS = 66_000;

function listen(server: http.Server, port: number, host?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    const onListening = (): void => {
      server.removeListener("error", reject);
      resolve();
    };
    if (host === undefined) {
      server.listen(port, onListening);
    } else {
      server.listen(port, host, onListening);
    }
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
    server.closeIdleConnections();
  });
}

export async function startServer(): Promise<RunningServer> {
  registerDependencies();
  connectRedis(redis, logger);

  const publicServer = http.createServer(createApp());
  const internalServer = http.createServer(createInternalApp());
  for (const server of [publicServer, internalServer]) {
    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
    server.headersTimeout = HEADERS_TIMEOUT_MS;
  }

  try {
    await listen(publicServer, env.PORT);
    logger.info("server_listening", { listener: "public", port: env.PORT, host: "0.0.0.0" });
    await listen(internalServer, env.INTERNAL_PORT, env.INTERNAL_HOST);
    logger.info("server_listening", {
      listener: "internal",
      port: env.INTERNAL_PORT,
      host: env.INTERNAL_HOST,
    });
  } catch (err) {
    logger.error("server_listen_failed", { err });
    process.exit(1);
  }

  let shutdownPromise: Promise<number> | undefined;

  /** infrastructure.md §6: not-ready -> stop accepting -> drain -> close pools. Runs at most once. */
  const runShutdown = async (reason: ShutdownReason): Promise<number> => {
    lifecycle.markShuttingDown();
    logger.info("shutdown_started", { reason });

    let timer: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      Promise.all([closeServer(publicServer), closeServer(internalServer)]).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, env.SHUTDOWN_TIMEOUT_MS);
      }),
    ]);
    if (timer) {
      clearTimeout(timer);
    }

    if (!drained) {
      logger.error("shutdown_timeout", { unfinishedRequests: lifecycle.inflightCount() });
      publicServer.closeAllConnections();
      internalServer.closeAllConnections();
    }

    await db.destroy().catch(() => undefined);
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }

    if (!drained) {
      return 1;
    }
    return reason === "uncaughtException" || reason === "unhandledRejection" ? 1 : 0;
  };

  const shutdown = (reason: ShutdownReason): Promise<number> => {
    shutdownPromise ??= runShutdown(reason);
    return shutdownPromise;
  };

  return { publicServer, internalServer, shutdown };
}

if (require.main === module) {
  void startServer().then((server) => {
    const exitAfterShutdown = (reason: ShutdownReason): void => {
      void server.shutdown(reason).then((code) => {
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
