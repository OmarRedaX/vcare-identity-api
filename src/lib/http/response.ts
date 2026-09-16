import type { Response } from "express";
import { captureRoute } from "./route-capture";
import type { SuccessBody } from "./types";

/** The one success envelope (CLAUDE.md -> API conventions). */
export function sendSuccess<T>(
  res: Response,
  data: T,
  status: 200 | 201 | 202 = 200,
  meta?: Record<string, unknown>,
): void {
  captureRoute(res.req, res);
  const body: SuccessBody<T> = meta === undefined ? { success: true, data } : { success: true, data, meta };
  res.status(status).json(body);
}

export function sendNoContent(res: Response): void {
  captureRoute(res.req, res);
  res.status(204).end();
}

/** Bare JSON (no envelope) — health probes and JWKS only. */
export function sendRaw(res: Response, status: number, body: object): void {
  captureRoute(res.req, res);
  res.status(status).json(body);
}
