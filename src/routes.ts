import { Router } from "express";
import type { DependencyContainer } from "tsyringe";
import { buildHealthRouter } from "./app/health/routes";

/** Mount public module routers here; internal controllers are never imported by routes.ts. */
export function buildPublicRouter(scope?: DependencyContainer): Router {
  const router = Router();
  router.use("/health", buildHealthRouter(scope));
  return router;
}
