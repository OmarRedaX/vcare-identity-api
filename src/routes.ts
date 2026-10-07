import { Router } from "express";
import type { DependencyContainer } from "tsyringe";
import { buildAuthRouter } from "./app/auth/routes";
import { buildHealthRouter } from "./app/health/routes";
import { buildUsersRouter } from "./app/users/routes";

/** Mount public module routers here; internal controllers are never imported by routes.ts. */
export function buildPublicRouter(scope?: DependencyContainer): Router {
  const router = Router();
  router.use("/health", buildHealthRouter(scope));
  router.use("/auth", buildAuthRouter(scope));
  router.use("/users", buildUsersRouter(scope));
  return router;
}
