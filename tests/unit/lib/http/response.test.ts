import type { Request, Response } from "express";
import { noStore } from "../../../../src/lib/http/no-store";
import { sendNoContent, sendRaw, sendSuccess } from "../../../../src/lib/http/response";

interface FakeRes {
  statusCode: number;
  body: unknown;
  ended: boolean;
  headers: Record<string, string>;
  locals: Record<string, unknown>;
  req: Request;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
  end(): void;
  setHeader(name: string, value: string): void;
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    body: undefined,
    ended: false,
    headers: {},
    locals: {},
    req: { baseUrl: "/api", route: { path: "/things" } } as unknown as Request,
    status(code: number): FakeRes {
      res.statusCode = code;
      return res;
    },
    json(body: unknown): FakeRes {
      res.body = body;
      return res;
    },
    end(): void {
      res.ended = true;
    },
    setHeader(name: string, value: string): void {
      res.headers[name] = value;
    },
  };
  return res;
}

describe("sendSuccess", () => {
  it("should wrap data in the success envelope when sendSuccess is called", () => {
    const res = fakeRes();

    sendSuccess(res as unknown as Response, { id: 1 });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: { id: 1 } });
  });

  it("should use the given status when one is passed", () => {
    const res = fakeRes();

    sendSuccess(res as unknown as Response, { id: 1 }, 201);

    expect(res.statusCode).toBe(201);
  });

  it("should include meta only when it is provided", () => {
    const withoutMeta = fakeRes();
    sendSuccess(withoutMeta as unknown as Response, [1, 2]);
    expect(Object.keys(withoutMeta.body as object)).toEqual(["success", "data"]);

    const withMeta = fakeRes();
    sendSuccess(withMeta as unknown as Response, [1, 2], 200, { hasMore: false });
    expect(withMeta.body).toEqual({ success: true, data: [1, 2], meta: { hasMore: false } });
  });

  it("should record the route pattern when writing a response", () => {
    const res = fakeRes();

    sendSuccess(res as unknown as Response, { id: 1 });

    expect(res.locals.routePattern).toBe("/api/things");
  });
});

describe("sendNoContent", () => {
  it("should send 204 without a body when sendNoContent is called", () => {
    const res = fakeRes();

    sendNoContent(res as unknown as Response);

    expect(res.statusCode).toBe(204);
    expect(res.body).toBeUndefined();
    expect(res.ended).toBe(true);
  });
});

describe("sendRaw", () => {
  it("should send the bare body without the envelope when sendRaw is called", () => {
    const res = fakeRes();

    sendRaw(res as unknown as Response, 503, { status: "down" });

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ status: "down" });
  });
});

describe("noStore", () => {
  it("should set Cache-Control no-store when noStore runs", () => {
    const res = fakeRes();
    const next = jest.fn();

    noStore()({} as Request, res as unknown as Response, next);

    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(next).toHaveBeenCalledTimes(1);
  });
});
