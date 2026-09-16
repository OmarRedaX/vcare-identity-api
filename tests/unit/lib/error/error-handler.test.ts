import type { NextFunction, Request, Response } from "express";
import { captureLogs } from "../../../helpers/log-capture";
import { AppError } from "../../../../src/lib/error/AppError";
import { errorHandler, notFoundHandler } from "../../../../src/lib/error/errorHandler";
import { Conflict, ValidationFailed } from "../../../../src/lib/error/errors";
import type { ErrorBody } from "../../../../src/lib/error/types";

const REQUEST_ID = "7f1c0a2e-0000-4000-8000-00000000abcd";

interface FakeRes {
  statusCode: number;
  body: unknown;
  headersSent: boolean;
  writableEnded: boolean;
  ended: boolean;
  locals: Record<string, unknown>;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
  end(): void;
}

function fakeReq(): Request {
  return {
    requestId: REQUEST_ID,
    method: "POST",
    baseUrl: "/api",
    body: { password: "fixture-password", email: "person@example.test" },
    headers: { authorization: "Bearer fixture-token", cookie: "vcare_rt=fixture-cookie" },
    query: { secret: "fixture-query" },
  } as unknown as Request;
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    writableEnded: false,
    ended: false,
    locals: {},
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
  };
  return res;
}

function handle(err: unknown, res: FakeRes, next: NextFunction = jest.fn()): void {
  errorHandler(err, fakeReq(), res as unknown as Response, next);
}

function bodyOf(res: FakeRes): ErrorBody {
  return res.body as ErrorBody;
}

describe("errorHandler", () => {
  it("should render code status and message when an AppError is passed", () => {
    const res = fakeRes();

    handle(Conflict, res);

    expect(res.statusCode).toBe(409);
    expect(bodyOf(res).success).toBe(false);
    expect(bodyOf(res).error.code).toBe("Conflict");
    expect(bodyOf(res).error.message).toBe("Request conflicts with the current state");
  });

  it("should include details when the AppError has details", () => {
    const res = fakeRes();

    handle(ValidationFailed.withDetails([{ field: "email", issue: "must be an email" }]), res);

    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error.details).toEqual([{ field: "email", issue: "must be an email" }]);
  });

  it("should render details as an empty array when the AppError has none", () => {
    const res = fakeRes();

    handle(Conflict, res);

    expect(bodyOf(res).error.details).toEqual([]);
    expect(Object.keys(bodyOf(res).error)).toEqual(["code", "message", "details", "requestId"]);
  });

  it("should return 400 ValidationFailed on field body when JSON parsing failed", () => {
    const res = fakeRes();

    handle({ type: "entity.parse.failed", status: 400, message: "Unexpected token }" }, res);

    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error.code).toBe("ValidationFailed");
    expect(bodyOf(res).error.details).toEqual([{ field: "body", issue: "must be valid JSON" }]);
  });

  it("should return 400 ValidationFailed on field body when the body exceeds the limit", () => {
    const res = fakeRes();

    handle({ type: "entity.too.large", status: 413 }, res);

    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error.details).toEqual([{ field: "body", issue: "must not exceed 100kb" }]);
  });

  it("should return 400 ValidationFailed on field body when the charset is unsupported", () => {
    const res = fakeRes();

    handle({ type: "charset.unsupported", status: 415 }, res);

    expect(bodyOf(res).error.details).toEqual([{ field: "body", issue: "has an unsupported encoding" }]);
  });

  it("should write no body when the request was aborted", () => {
    const res = fakeRes();

    handle({ type: "request.aborted", status: 400 }, res);

    expect(res.body).toBeUndefined();
    expect(res.ended).toBe(true);
  });

  it("should return 400 ValidationFailed when another error carries a 4xx status", () => {
    const res = fakeRes();

    handle({ status: 400, message: "bad request from a library" }, res);

    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error.code).toBe("ValidationFailed");
    expect(bodyOf(res).error.details).toEqual([{ field: "body", issue: "is invalid" }]);
  });

  it("should return 500 InternalError without the original message when an unknown error is passed", () => {
    const res = fakeRes();

    handle(new Error("connection to postgres://identity:fixture-secret@db failed"), res);

    expect(res.statusCode).toBe(500);
    expect(bodyOf(res).error.code).toBe("InternalError");
    expect(bodyOf(res).error.message).toBe("Internal server error");
    expect(JSON.stringify(res.body)).not.toContain("fixture-secret");
    expect(JSON.stringify(res.body)).not.toContain("postgres://");
  });

  it("should log the stack at error level when the error is unknown", () => {
    const capture = captureLogs();
    try {
      handle(new Error("boom"), fakeRes());

      const line = capture.lines().find((entry) => entry.message === "unhandled_error");
      expect(line).toBeDefined();
      expect(line?.level).toBe("error");
      const err = line?.err as { name: string; message: string; stack: string };
      expect(err.message).toBe("boom");
      expect(typeof err.stack).toBe("string");
    } finally {
      capture.restore();
    }
  });

  it("should not log the request body or headers when handling any error", () => {
    const capture = captureLogs();
    try {
      handle(new Error("boom"), fakeRes());
      handle(Conflict, fakeRes());
      handle({ type: "entity.parse.failed" }, fakeRes());

      const text = capture.text();
      expect(text).not.toContain("fixture-password");
      expect(text).not.toContain("person@example.test");
      expect(text).not.toContain("fixture-token");
      expect(text).not.toContain("fixture-cookie");
      expect(text).not.toContain("fixture-query");
    } finally {
      capture.restore();
    }
  });

  it("should delegate to next when headers were already sent", () => {
    const res = fakeRes();
    res.headersSent = true;
    const next = jest.fn();
    const err = new Error("late failure");

    handle(err, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.body).toBeUndefined();
  });

  it("should put the request id in the body when rendering an error", () => {
    const res = fakeRes();

    handle(Conflict, res);

    expect(bodyOf(res).error.requestId).toBe(REQUEST_ID);
  });
});

describe("notFoundHandler", () => {
  it("should respond 404 NotFound when notFoundHandler runs", () => {
    const next = jest.fn<void, [unknown]>();

    notFoundHandler(fakeReq(), fakeRes() as unknown as Response, next);

    const passed = next.mock.calls[0]?.[0] as AppError;
    expect(passed).toBeInstanceOf(AppError);
    expect(passed.code).toBe("NotFound");
    expect(passed.status).toBe(404);
  });
});
