import type { RequestHandler } from "express";
import { logger as defaultLogger, Logger } from "./logger";

const HEALTH_PREFIXES = ["/api/health/", "/internal/health/"];
const CLIENT_CLOSED_STATUS = 499;

/**
 * Logs one `request_completed` line per request. Never logs headers, query strings, raw URLs or bodies
 * (CLAUDE.md -> Privacy and logging).
 */
export function requestLogger(log: Logger = defaultLogger): RequestHandler {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    // The socket "close" event runs outside the request context, so the id is captured on entry.
    const requestId = req.requestId;
    let logged = false;

    const complete = (clientClosed: boolean): void => {
      if (logged) {
        return;
      }
      logged = true;

      const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10;
      const pattern = (res.locals as Record<string, unknown>).routePattern;
      const route = typeof pattern === "string" ? pattern : "unmatched";
      const status = clientClosed ? CLIENT_CLOSED_STATUS : res.statusCode;

      if (status < 500 && HEALTH_PREFIXES.some((prefix) => route.startsWith(prefix))) {
        return;
      }

      const fields = { requestId, method: req.method, route, status, durationMs };
      if (status >= 500) {
        log.error("request_completed", fields);
      } else {
        log.info("request_completed", fields);
      }
    };

    res.on("finish", () => {
      complete(false);
    });
    res.on("close", () => {
      complete(true);
    });

    next();
  };
}
