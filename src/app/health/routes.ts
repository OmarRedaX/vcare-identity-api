import { Router } from "express";
import type { DependencyContainer } from "tsyringe";
import { container as rootContainer } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { sealRouter } from "../../lib/http/route-capture";
import type { HealthController } from "./controller/health.controller";

/**
 * The only routes without `authorize(...)`: infrastructure probes with no principal and no domain
 * (brainstorm -> Primary flows; ADR 0014). They are not rate-limited, not idempotent, not enveloped,
 * and the edge never routes them (hub ADR 0005).
 */
export function buildHealthRouter(scope: DependencyContainer = rootContainer): Router {
  const controller = scope.resolve<HealthController>(TOKENS.HealthController);
  const router = Router();

  router.get("/live", controller.live);
  router.get("/ready", (req, res, next) => {
    controller.ready(req, res).catch(next);
  });

  return sealRouter(router);
}
