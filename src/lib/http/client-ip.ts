import type { Request } from "express";

const IPV4_MAPPED_PREFIX = "::ffff:";

/** Trustworthy only because both apps set `trust proxy` to TRUST_PROXY_HOPS (spec §4.17). */
export function clientIp(req: Request): string {
  const address = req.ip ?? req.socket.remoteAddress ?? "unknown";
  return address.startsWith(IPV4_MAPPED_PREFIX) ? address.slice(IPV4_MAPPED_PREFIX.length) : address;
}
