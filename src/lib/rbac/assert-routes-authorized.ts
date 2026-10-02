import type { Router } from "express";
import { isAuthorizeHandler } from "./authorize";
import type { StackLayer } from "./types";

/**
 * Infrastructure probes are the only routes without a policy (ADR 0014): they carry no principal and no
 * domain, and the edge never routes them. Marking is explicit, so "no policy" can never be an oversight.
 */
export const PROBE_EXEMPT_MARKER = Symbol.for("vcare.probe-exempt");

export function markProbeExempt(router: Router): Router {
  Object.defineProperty(router, PROBE_EXEMPT_MARKER, { value: true, enumerable: false });
  return router;
}

function isProbeExempt(value: unknown): boolean {
  return (
    typeof value === "function" &&
    (value as unknown as Record<symbol, unknown>)[PROBE_EXEMPT_MARKER] === true
  );
}

function stackOf(value: unknown): readonly StackLayer[] | undefined {
  if (typeof value !== "function" && (typeof value !== "object" || value === null)) {
    return undefined;
  }
  const stack = (value as { stack?: unknown }).stack;
  return Array.isArray(stack) ? (stack as readonly StackLayer[]) : undefined;
}

function methodsOf(layer: StackLayer): string {
  const methods = layer.route?.methods ?? {};
  const names = Object.keys(methods)
    .filter((method) => methods[method] === true)
    .map((method) => method.toUpperCase());
  return names.length > 0 ? names.join(",") : "ALL";
}

function walk(value: unknown, basePath: string): void {
  const stack = stackOf(value);
  if (stack === undefined) {
    return;
  }

  for (const layer of stack) {
    if (layer.route !== undefined) {
      const routeStack = layer.route.stack ?? [];
      if (!routeStack.some((entry) => isAuthorizeHandler(entry.handle))) {
        const path = typeof layer.route.path === "string" ? layer.route.path : "";
        throw new Error(`route_without_policy: ${methodsOf(layer)} ${basePath}${path}`);
      }
      continue;
    }

    if (isProbeExempt(layer.handle)) {
      continue;
    }
    walk(layer.handle, basePath);
  }
}

/**
 * Boot-time fail-closed check (BR-27): every route reachable from `router` must have an `authorize(...)`
 * handler in its stack. Called by `createApp` / `createInternalApp`; a violation throws in **every**
 * environment, so the process cannot start with an unguarded route.
 */
export function assertRoutesAuthorized(router: Router, basePath: string): void {
  walk(router, basePath);
}
