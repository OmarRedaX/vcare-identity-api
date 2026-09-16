import type { ErrorRequestHandler, Request, Response, Router } from "express";

/** Records the matched route pattern for the request log without ever touching the raw URL. */
export function captureRoute(req: Request, res: Response): void {
  const locals = res.locals as Record<string, unknown>;
  if (typeof locals.routePattern === "string") {
    return;
  }
  const route = req.route as { path?: unknown } | undefined;
  if (route && typeof route.path === "string") {
    locals.routePattern = `${req.baseUrl}${route.path}`;
  }
}

export function routeCaptureOnError(): ErrorRequestHandler {
  return (err, req, res, next) => {
    captureRoute(req, res);
    next(err);
  };
}

/** Every module router is returned through this, so thrown errors still record their pattern. */
export function sealRouter(router: Router): Router {
  router.use(routeCaptureOnError());
  return router;
}
