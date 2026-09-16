import { Router } from "express";
import type { DependencyContainer } from "tsyringe";
import { buildHealthRouter } from "./app/health/routes";

/** Mount internal module routers here; they are served only on the internal listener (INTERNAL_PORT). */
export function buildInternalRouter(scope?: DependencyContainer): Router {
  const router = Router();
  router.use("/health", buildHealthRouter(scope));
  return router;
}
