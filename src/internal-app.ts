import express, { type Express } from "express";
import helmet from "helmet";
import { env } from "./lib/config/env";
import { errorHandler, notFoundHandler } from "./lib/error/errorHandler";
import { buildInternalRouter } from "./internal-routes";
import { inflightTracker } from "./lib/lifecycle/inflight";
import { requestLogger } from "./lib/logger/request-logger";
import { requestId } from "./lib/request-id/request-id";
import type { InternalAppOptions } from "./types";

const JSON_BODY_LIMIT = "100kb";

/** Internal listener app (INTERNAL_PORT), never reachable through the public ingress. No CORS. */
export function createInternalApp(options?: InternalAppOptions): Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY_HOPS);

  app.use(inflightTracker());
  app.use(requestId());
  app.use(requestLogger());
  app.use(helmet({ hsts: false }));
  app.use(express.json({ limit: JSON_BODY_LIMIT, strict: true, type: "application/json" }));

  app.use("/internal", buildInternalRouter(options?.scope));
  if (options?.extraInternalRouter) {
    app.use("/internal", options.extraInternalRouter);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
