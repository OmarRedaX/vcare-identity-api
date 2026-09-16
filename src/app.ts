import express, { type Express } from "express";
import helmet from "helmet";
import { env } from "./lib/config/env";
import { errorHandler, notFoundHandler } from "./lib/error/errorHandler";
import { cors } from "./lib/http/cors";
import { inflightTracker } from "./lib/lifecycle/inflight";
import { logger } from "./lib/logger/logger";
import { requestLogger } from "./lib/logger/request-logger";
import { requestId } from "./lib/request-id/request-id";
import { buildPublicRouter } from "./routes";
import type { AppOptions } from "./types";

const JSON_BODY_LIMIT = "100kb";

/** Public listener app, mounted under /api (CLAUDE.md -> API conventions). */
export function createApp(options?: AppOptions): Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY_HOPS);

  app.use(inflightTracker());
  app.use(requestId());
  app.use(requestLogger());
  app.use(helmet({ hsts: env.NODE_ENV === "production" }));

  if (env.CORS_ORIGINS.length > 0) {
    if (env.NODE_ENV === "production") {
      // Production is a single origin with CORS disabled (hub ADR 0005).
      logger.warn("cors_origins_ignored_in_production");
    } else {
      app.use(cors({ origins: env.CORS_ORIGINS }));
    }
  }

  app.use(express.json({ limit: JSON_BODY_LIMIT, strict: true, type: "application/json" }));

  app.use("/api", buildPublicRouter(options?.scope));
  if (options?.extraApiRouter) {
    app.use("/api", options.extraApiRouter);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
