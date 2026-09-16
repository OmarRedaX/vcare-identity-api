import type { Request, Response } from "express";
import { getRequestContext } from "../../../../src/lib/request-id/context";
import { requestId, UUID_PATTERN } from "../../../../src/lib/request-id/request-id";

interface Harness {
  req: Request;
  headers: Record<string, string>;
  order: string[];
}

function run(incoming?: string, onNext?: () => void): Harness {
  const headers: Record<string, string> = {};
  const order: string[] = [];
  const req = {
    headers: incoming === undefined ? {} : { "x-request-id": incoming },
  } as unknown as Request;
  const res = {
    setHeader(name: string, value: string): void {
      headers[name] = value;
      order.push("setHeader");
    },
  } as unknown as Response;

  requestId()(req, res, () => {
    order.push("next");
    onNext?.();
  });

  return { req, headers, order };
}

describe("requestId", () => {
  it("should adopt the incoming id lower-cased when X-Request-Id is a UUID", () => {
    const { req, headers } = run("7F1C0A2E-1234-4ABC-8DEF-000000000001");

    expect(req.requestId).toBe("7f1c0a2e-1234-4abc-8def-000000000001");
    expect(headers["X-Request-Id"]).toBe("7f1c0a2e-1234-4abc-8def-000000000001");
  });

  it("should generate a UUID when X-Request-Id is not a UUID", () => {
    const { req } = run("not-a-uuid");

    expect(req.requestId).not.toBe("not-a-uuid");
    expect(UUID_PATTERN.test(req.requestId)).toBe(true);
  });

  it("should generate a UUID when X-Request-Id is absent", () => {
    const { req, headers } = run();

    expect(UUID_PATTERN.test(req.requestId)).toBe(true);
    expect(headers["X-Request-Id"]).toBe(req.requestId);
  });

  it("should set the response header before calling next", () => {
    const { order } = run();

    expect(order).toEqual(["setHeader", "next"]);
  });

  it("should expose the id through getRequestContext when inside the request", () => {
    let seen: string | undefined;
    const { req } = run(undefined, () => {
      seen = getRequestContext()?.requestId;
    });

    expect(seen).toBe(req.requestId);
    expect(getRequestContext()).toBeUndefined();
  });
});
