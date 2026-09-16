import type { Request } from "express";
import { clientIp } from "../../../../src/lib/http/client-ip";

function reqWith(ip: string | undefined, remoteAddress?: string): Request {
  return { ip, socket: { remoteAddress } } as unknown as Request;
}

describe("clientIp", () => {
  it("should strip the IPv4-mapped prefix when the address is IPv4-mapped IPv6", () => {
    expect(clientIp(reqWith("::ffff:203.0.113.7"))).toBe("203.0.113.7");
  });

  it("should return the address unchanged when it is plain IPv4", () => {
    expect(clientIp(reqWith("203.0.113.7"))).toBe("203.0.113.7");
  });

  it("should fall back to the socket address when req.ip is undefined", () => {
    expect(clientIp(reqWith(undefined, "198.51.100.4"))).toBe("198.51.100.4");
  });

  it("should return unknown when neither req.ip nor the socket has an address", () => {
    expect(clientIp(reqWith(undefined, undefined))).toBe("unknown");
  });
});
