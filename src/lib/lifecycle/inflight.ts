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

    res.on("finish", end);
    res.on("close", end);
    next();
  };
}
