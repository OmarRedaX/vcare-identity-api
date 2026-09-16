import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestContext } from "./types";

/** Carries the request id (and later the principal) to every log line without threading it through calls. */
export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}
