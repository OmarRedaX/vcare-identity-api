import { Router } from "express";
import type { DependencyContainer } from "tsyringe";
import { serviceGuard } from "../../src/lib/auth/service-guard";
import type { SigningKeySet } from "../../src/lib/auth/types";
import { container as rootContainer } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import { authorize } from "../../src/lib/rbac/authorize";
import type { Clock } from "../../src/lib/time/types";
import { IsInt, IsString, Max, MaxLength, Min } from "class-validator";
import { Conflict } from "../../src/lib/error/errors";
import { clientIp } from "../../src/lib/http/client-ip";
import { buildPage } from "../../src/lib/http/pagination/page";
import { sendSuccess } from "../../src/lib/http/response";
import { sealRouter } from "../../src/lib/http/route-capture";
import { idempotency } from "../../src/lib/idempotency/idempotency";
import { rateLimit } from "../../src/lib/rate-limit/rate-limit";
import { validateBody } from "../../src/lib/validation/validate";
import type { TestRouterDeps } from "./types";

class EchoDto {
  @IsString()
  @MaxLength(50)
  name!: string;

  @IsInt()
  @Min(1)
  @Max(10)
  count!: number;
}

const PAGE_ROWS = Array.from({ length: 5 }, (_value, index) => ({ id: index + 1, name: `row-${index + 1}` }));

export const testCounters = { idem: 0 };

export function resetTestCounters(): void {
  testCounters.idem = 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Test-only routes, mounted through extraApiRouter — never referenced by src/routes.ts. */
export function buildTestRouter(deps?: TestRouterDeps): Router {
  const router = Router();
  const idempotencyDeps =
    deps?.redis && deps.logger ? { redis: deps.redis, logger: deps.logger } : undefined;

  router.post("/__test/echo", async (req, res) => {
    const dto = await validateBody(EchoDto, req.body as unknown);
    sendSuccess(res, { name: dto.name, count: dto.count }, 201);
  });

  router.get("/__test/boom", () => {
    throw new Error("db password=synthetic-value");
  });

  router.get("/__test/app-error", () => {
    throw Conflict;
  });

  const idemHandler = async (req: import("express").Request, res: import("express").Response): Promise<void> => {
    const delayMs = Number(req.query.delayMs ?? 0);
    if (Number.isFinite(delayMs) && delayMs > 0) {
      await delay(delayMs);
    }
    testCounters.idem += 1;
    sendSuccess(res, { runs: testCounters.idem, id: req.params.id ?? null }, 201);
  };

  router.post("/__test/idem", idempotency({ required: true }, idempotencyDeps), idemHandler);
  router.post("/__test/idem/:id", idempotency({ required: true }, idempotencyDeps), idemHandler);
  router.post("/__test/idem-optional", idempotency({ required: false }, idempotencyDeps), idemHandler);

  router.get(
    "/__test/limited",
    rateLimit(
      { name: "test", limit: 3, windowMs: 1000, subject: clientIp, degrade: deps?.degrade ?? "fallback" },
      deps?.redis && deps.logger
        ? { redis: deps.redis, logger: deps.logger, fallbackDivisor: 2, now: () => Date.now() }
        : undefined,
    ),
    (_req, res) => {
      sendSuccess(res, { ok: true });
    },
  );

  router.get("/__test/page", (req, res) => {
    const limit = Number(req.query.limit ?? 2);
    const page = buildPage(PAGE_ROWS, limit, (row) => ({ v: row.name, id: row.id }));
    sendSuccess(res, page.items, 200, {
      nextCursor: page.meta.nextCursor,
      hasMore: page.meta.hasMore,
      count: page.meta.count,
    });
  });

  return sealRouter(router);
}

/**
 * Test-only guarded internal routes, mounted through `extraInternalRouter`. They stand in for the routes the
 * `internal-users` module will add, so the guard and the `service` policy kind are exercised through the real
 * `createInternalApp` wiring: `serviceGuard -> authorize({ kind: "service", scope }) -> handler`.
 */
export function buildInternalProbeRouter(scope: DependencyContainer = rootContainer): Router {
  const keys = scope.resolve<SigningKeySet>(TOKENS.SigningKeys);
  const clock = scope.resolve<Clock>(TOKENS.Clock);
  const guard = serviceGuard({ keys, clock });
  const router = Router();

  const principal = (req: import("express").Request, res: import("express").Response): void => {
    const auth = req.auth;
    sendSuccess(res, auth?.kind === "service" ? { clientId: auth.clientId, scopes: auth.scopes } : null);
  };

  router.get(
    "/__test/read",
    guard,
    authorize({ kind: "service", scope: "users:read", owner: "none" }),
    principal,
  );
  router.patch(
    "/__test/write",
    guard,
    authorize({ kind: "service", scope: "users:status:write", owner: "none" }),
    principal,
  );

  return sealRouter(router);
}
