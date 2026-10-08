import { Router } from "express";
import type { DependencyContainer } from "tsyringe";
import { serviceGuard } from "../../lib/auth/service-guard";
import type { SigningKeySet } from "../../lib/auth/types";
import { container as rootContainer } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { noStore } from "../../lib/http/no-store";
import { sealRouter } from "../../lib/http/route-capture";
import { authorize } from "../../lib/rbac/authorize";
import type { Clock } from "../../lib/time/types";
import type { InternalUsersController } from "./controller/internal-users.controller";
import { internalBatchPolicy, internalContactsPolicy, internalStatusPolicy } from "./policies";

/**
 * Per-route order: serviceGuard -> authorize(policy) -> handler. No idempotency middleware (a status PATCH to the
 * same status is idempotent by nature) and no limiter (the caller is one authenticated internal client). The
 * contacts and status responses are `Cache-Control: no-store`; the contacts response carries email addresses.
 */
export function buildInternalUsersRouter(scope: DependencyContainer = rootContainer): Router {
  const controller = scope.resolve<InternalUsersController>(TOKENS.InternalUsersController);
  const keys = scope.resolve<SigningKeySet>(TOKENS.SigningKeys);
  const clock = scope.resolve<Clock>(TOKENS.Clock);
  const guard = serviceGuard({ keys, clock });

  const router = Router();

  // No no-store here: the batch shape carries no PII (the contract declares no Cache-Control).
  router.get("/", guard, authorize(internalBatchPolicy), controller.batchGetUsers);
  router.get("/contacts", guard, authorize(internalContactsPolicy), noStore(), controller.getContacts);
  router.patch(
    "/:id/status",
    guard,
    authorize(internalStatusPolicy),
    noStore(),
    controller.updateUserStatus,
  );

  return sealRouter(router);
}
