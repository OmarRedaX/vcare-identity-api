import type { Request } from "express";

const IPV4_MAPPED_PREFIX = "::ffff:";

/**
 * Trustworthy only because each app sets `trust proxy` from its own hop count: TRUST_PROXY_HOPS on the public app,
 * INTERNAL_TRUST_PROXY_HOPS on the internal app (spec §4.17).
 */
export function clientIp(req: Request): string {
  const address = req.ip ?? req.socket.remoteAddress ?? "unknown";
  return address.startsWith(IPV4_MAPPED_PREFIX) ? address.slice(IPV4_MAPPED_PREFIX.length) : address;
}
