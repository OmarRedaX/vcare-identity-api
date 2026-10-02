import type { Request, Response } from "express";
import {
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_SECONDS,
} from "../auth/constants";

/**
 * The refresh cookie is the only cookie this service uses, so it is parsed and written here rather than
 * with a cookie parser (ADR 0016). Cookie headers and refresh tokens are never logged.
 */
const ATTRIBUTES = `HttpOnly; Secure; SameSite=Strict; Path=${REFRESH_COOKIE_PATH}`;

/** Duplicate names: the first wins. Values that are not valid percent-encoding are returned as sent. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== "string" || header.length === 0) {
    return undefined;
  }

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    if (part.slice(0, separator).trim() !== name) {
      continue;
    }
    const raw = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  return undefined;
}

export function readRefreshCookie(req: Request): string | undefined {
  return readCookie(req, REFRESH_COOKIE_NAME);
}

/** `Secure` is always set: browsers treat localhost as a secure origin and CURL ignores the attribute. */
export function setRefreshCookie(res: Response, token: string): void {
  res.setHeader(
    "Set-Cookie",
    `${REFRESH_COOKIE_NAME}=${token}; ${ATTRIBUTES}; Max-Age=${String(REFRESH_TOKEN_TTL_SECONDS)}`,
  );
}

export function clearRefreshCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${REFRESH_COOKIE_NAME}=; ${ATTRIBUTES}; Max-Age=0`);
}
