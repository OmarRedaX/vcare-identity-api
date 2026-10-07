import { Router } from "express";
import type { DependencyContainer } from "tsyringe";
import { userGuard } from "../../lib/auth/user-guard";
import type { SigningKeySet } from "../../lib/auth/types";
import { container as rootContainer } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { noStore } from "../../lib/http/no-store";
import { sealRouter } from "../../lib/http/route-capture";
import { authorize } from "../../lib/rbac/authorize";
import type { Clock } from "../../lib/time/types";
import type { UsersController } from "./controller/users.controller";
import { adminUsersPolicy } from "./policies";

/**
 * Per-route order: userGuard -> authorize(policy) -> handler (spec section 4). No idempotency middleware
 * (PATCH to the same status and DELETE are idempotent by nature) and no limiter (spec 8.4). The four 200
 * responses carry PII, so they are `Cache-Control: no-store` (contract C-1); the `204` carries no body.
 */
export function buildUsersRouter(scope: DependencyContainer = rootContainer): Router {
  const controller = scope.resolve<UsersController>(TOKENS.UsersController);
  const keys = scope.resolve<SigningKeySet>(TOKENS.SigningKeys);
  const clock = scope.resolve<Clock>(TOKENS.Clock);
  const guard = userGuard({ keys, clock });

  const router = Router();

  router.get("/", guard, authorize(adminUsersPolicy), noStore(), controller.listUsers);
  router.get("/:id", guard, authorize(adminUsersPolicy), noStore(), controller.getUser);
  router.patch(
    "/:id/status",
    guard,
    authorize(adminUsersPolicy),
    noStore(),
    controller.updateUserStatus,
  );
  router.get(
    "/:id/sessions",
    guard,
    authorize(adminUsersPolicy),
    noStore(),
    controller.listUserSessions,
  );
  router.delete("/:id/sessions", guard, authorize(adminUsersPolicy), controller.revokeUserSessions);

  return sealRouter(router);
}
