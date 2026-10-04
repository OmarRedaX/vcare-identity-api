import type { RequestHandler } from "express";
import { lifecycle as defaultLifecycle, Lifecycle } from "./lifecycle";

/** Counts a request exactly once, whichever of finish/close fires first. */
export function inflightTracker(lc: Lifecycle = defaultLifecycle): RequestHandler {
  return (_req, res, next) => {
    lc.requestStarted();
    let ended = false;
    const end = (): void => {
      if (ended) {
        return;
      }
      ended = true;
      lc.requestEnded();
    };

    if (lc.isShuttingDown()) {
      res.setHeader("Connection", "close");
    }

    res.on("finish", () => {
      end();
      // A keep-alive socket whose last request ends during shutdown would otherwise stay open and
      // stall server.close() until the shutdown deadline.
      if (lc.isShuttingDown() && !res.req.socket.destroyed) {
        res.req.socket.end();
      }
    });
    res.on("close", end);
    next();
  };
}
