import { EventEmitter } from "node:events";
import express, { type ErrorRequestHandler, type Express, type Request, type RequestHandler, type Response } from "express";
import type Redis from "ioredis";
import request from "supertest";
import { AppError } from "../../../../src/lib/error/AppError";
import { hashBody, idempotency, idempotencyKey } from "../../../../src/lib/idempotency/idempotency";
import type { IdempotencyRecord } from "../../../../src/lib/idempotency/types";
import { Logger } from "../../../../src/lib/logger/logger";

// Several cases drive a real express app through supertest with timed Redis stubs; the default 5 s budget is
// tight when all unit workers compile in parallel on a loaded machine.
jest.setTimeout(20_000);

const KEY = "3f0c9a2e-1111-4111-8111-111111111111";
const REQUEST_ID = "11111111-2222-4222-8222-222222222222";

interface FakeRedis {
  client: Redis;
  store: Map<string, string>;
  set: jest.Mock;
  get: jest.Mock;
  del: jest.Mock;
  evalScript: jest.Mock;
}

interface LogSink {
  logger: Logger;
  lines: () => Record<string, unknown>[];
  text: () => string;
}

function logSink(): LogSink {
  const written: string[] = [];
  return {
    logger: new Logger({
      service: "identity-service",
      level: "debug",
      production: false,
      sink: (line) => {
        written.push(line);
      },
    }),
    lines: () =>
      written
        .join("")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    text: () => written.join(""),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeRedis(options?: { status?: string; commandDelayMs?: number }): FakeRedis {
  const store = new Map<string, string>();
  const status = options?.status ?? "ready";
  const commandDelayMs = options?.commandDelayMs ?? 0;

  const withDelay = <T>(value: T): Promise<T> =>
    commandDelayMs > 0 ? delay(commandDelayMs).then(() => value) : Promise.resolve(value);

  const set = jest.fn((...args: unknown[]): Promise<string | null> => {
    const [key, value, , , nx] = args as [string, string, string, number, string | undefined];
    if (nx === "NX" && store.has(key)) {
      return withDelay<string | null>(null);
    }
    store.set(key, value);
    return withDelay<string | null>("OK");
  });

  const get = jest.fn((...args: unknown[]): Promise<string | null> => {
    const [key] = args as [string];
    return withDelay(store.get(key) ?? null);
  });

  const del = jest.fn((...args: unknown[]): Promise<number> => {
    const [key] = args as [string];
    store.delete(key);
    return withDelay(1);
  });

  // Compare-and-delete used to remove an orphaned in-flight claim: (script, numKeys, key, expectedValue).
  const evalScript = jest.fn((...args: unknown[]): Promise<number> => {
    const [, , key, expected] = args as [string, number, string, string];
    if (store.get(key) === expected) {
      store.delete(key);
      return Promise.resolve(1);
    }
    return Promise.resolve(0);
  });

  const client = { status, set, get, del, eval: evalScript } as unknown as Redis;
  return { client, store, set, get, del, evalScript };
}

// Express recognises an error handler by its arity, so the unused fourth parameter has to stay.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const renderError: ErrorRequestHandler = (err, _req, res, _next) => {
  const error = err as AppError;
  res.status(error.status).json({ code: error.code, details: error.details });
};

function buildApp(
  deps: { redis: Redis; logger: Logger },
  options: { required: boolean },
  handler?: RequestHandler,
): { app: Express; runs: () => number } {
  let runs = 0;
  const defaultHandler: RequestHandler = (req, res) => {
    runs += 1;
    res.status(201).json({ success: true, data: { runs, id: req.params.id ?? null } });
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.requestId = REQUEST_ID;
    next();
  });
  app.post("/things", idempotency(options, deps), handler ?? defaultHandler);
  app.post("/things/:id", idempotency(options, deps), handler ?? defaultHandler);
  app.use(renderError);

  return { app, runs: () => runs };
}

function record(store: Map<string, string>, key: string): IdempotencyRecord {
  return JSON.parse(store.get(key) ?? "null") as IdempotencyRecord;
}

function onlyKey(store: Map<string, string>): string {
  const [first] = [...store.keys()];
  return first ?? "";
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("idempotency middleware", () => {
  it("should respond 400 ValidationFailed when the key is required and missing", async () => {
    const redis = fakeRedis();
    const { app, runs } = buildApp({ redis: redis.client, logger: logSink().logger }, { required: true });

    const response = await request(app).post("/things").send({ a: 1 });
    const body = response.body as { code: string; details: { field: string; issue: string }[] };

    expect(response.status).toBe(400);
    expect(body.code).toBe("ValidationFailed");
    expect(body.details).toEqual([{ field: "Idempotency-Key", issue: "is required" }]);
    expect(runs()).toBe(0);
  });

  it("should call next without touching Redis when the key is optional and missing", async () => {
    const redis = fakeRedis();
    const { app, runs } = buildApp({ redis: redis.client, logger: logSink().logger }, { required: false });

    const response = await request(app).post("/things").send({ a: 1 });

    expect(response.status).toBe(201);
    expect(runs()).toBe(1);
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it("should respond 400 ValidationFailed when the key is not a UUID", async () => {
    const redis = fakeRedis();
    const { app } = buildApp({ redis: redis.client, logger: logSink().logger }, { required: true });

    const response = await request(app).post("/things").set("Idempotency-Key", "not-a-uuid").send({ a: 1 });
    const body = response.body as { code: string; details: { field: string; issue: string }[] };

    expect(response.status).toBe(400);
    expect(body.details).toEqual([{ field: "Idempotency-Key", issue: "must be a UUID" }]);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("should skip and log idempotency_skipped when Redis is not ready", async () => {
    const redis = fakeRedis({ status: "connecting" });
    const log = logSink();
    const { app, runs } = buildApp({ redis: redis.client, logger: log.logger }, { required: true });

    const response = await request(app).post("/things").set("Idempotency-Key", KEY).send({ a: 1 });

    expect(response.status).toBe(201);
    expect(runs()).toBe(1);
    expect(redis.set).not.toHaveBeenCalled();
    const line = log.lines().find((entry) => entry.message === "idempotency_skipped");
    expect(line?.reason).toBe("redis_unavailable");
    expect(log.text()).not.toContain(KEY);
  });

  it("should skip when a Redis command exceeds 100 ms before the handler", async () => {
    const redis = fakeRedis({ commandDelayMs: 160 });
    const log = logSink();
    const { app, runs } = buildApp({ redis: redis.client, logger: log.logger }, { required: true });

    const response = await request(app).post("/things").set("Idempotency-Key", KEY).send({ a: 1 });

    expect(response.status).toBe(201);
    expect(runs()).toBe(1);
    const line = log.lines().find((entry) => entry.message === "idempotency_skipped");
    expect(line?.reason).toBe("redis_error");
  });

  it("should remove its own in-flight record when a timed-out claim lands late", async () => {
    const redis = fakeRedis({ commandDelayMs: 160 });
    const { app } = buildApp({ redis: redis.client, logger: logSink().logger }, { required: true });

    await request(app).post("/things").set("Idempotency-Key", KEY).send({ a: 1 });
    await delay(250);

    expect(redis.evalScript).toHaveBeenCalledTimes(1);
    expect(redis.store.size).toBe(0);
  });

  it("should delete the record when the handler finishes with 429", async () => {
    const redis = fakeRedis();
    const throttled: RequestHandler = (_req, res) => {
      res.status(429).json({ success: false });
    };
    const { app } = buildApp({ redis: redis.client, logger: logSink().logger }, { required: true }, throttled);

    await request(app).post("/things").set("Idempotency-Key", KEY).send({ a: 1 });
    await flush();

    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(redis.store.size).toBe(0);
  });

  it("should store status and body when the handler finishes below 500", async () => {
    const redis = fakeRedis();
    const { app } = buildApp({ redis: redis.client, logger: logSink().logger }, { required: true });

    await request(app).post("/things").set("Idempotency-Key", KEY).send({ a: 1 });
    await flush();

    const stored = record(redis.store, onlyKey(redis.store));
    expect(stored.state).toBe("completed");
    expect(stored.status).toBe(201);
    expect(stored.body).toEqual({ success: true, data: { runs: 1, id: null } });
    expect(stored.bodyHash).toBe(hashBody({ a: 1 }));
  });

  it("should delete the record when the handler finishes with 500 or more", async () => {
    const redis = fakeRedis();
    const failing: RequestHandler = (_req, res) => {
      res.status(500).json({ success: false });
    };
    const { app } = buildApp({ redis: redis.client, logger: logSink().logger }, { required: true }, failing);

    await request(app).post("/things").set("Idempotency-Key", KEY).send({ a: 1 });
    await flush();

    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(redis.store.size).toBe(0);
  });

  it("should keep the in-flight record on disconnect and store the handler outcome when it ends afterwards", async () => {
    const redis = fakeRedis();
    const middleware = idempotency({ required: true }, { redis: redis.client, logger: logSink().logger });

    const res = new EventEmitter() as EventEmitter & Response;
    Object.assign(res, {
      statusCode: 200,
      writableEnded: false,
      locals: {},
      json: () => res,
      send: () => res,
      status: () => res,
      setHeader: () => res,
      end: () => res,
    });
    const req = {
      method: "POST",
      baseUrl: "/api",
      path: "/things",
      headers: { "idempotency-key": KEY },
      body: { a: 1 },
      requestId: REQUEST_ID,
      ip: "203.0.113.7",
      socket: { remoteAddress: "203.0.113.7" },
    } as unknown as Request;

    const next = jest.fn();
    middleware(req, res, next);
    await flush();
    expect(next).toHaveBeenCalledTimes(1);

    res.emit("close");
    await flush();

    expect(redis.del).not.toHaveBeenCalled();
    expect(record(redis.store, onlyKey(redis.store)).state).toBe("in_flight");

    // The handler keeps running after the socket is gone and ends its response: the outcome is stored.
    res.statusCode = 201;
    res.json({ success: true });
    res.end();
    await flush();

    const stored = record(redis.store, onlyKey(redis.store));
    expect(stored.state).toBe("completed");
    expect(stored.status).toBe(201);
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("should replay the stored status and body without running the handler when the same key and body repeat", async () => {
    const redis = fakeRedis();
    const { app, runs } = buildApp({ redis: redis.client, logger: logSink().logger }, { required: true });

    const first = await request(app).post("/things").set("Idempotency-Key", KEY).send({ a: 1 });
    await flush();
    const second = await request(app).post("/things").set("Idempotency-Key", KEY).send({ a: 1 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(runs()).toBe(1);
  });

  it("should replace error.requestId with the current id when replaying an error body", async () => {
    const redis = fakeRedis();
    const stored: IdempotencyRecord = {
      v: 1,
      state: "completed",
      bodyHash: hashBody({ a: 1 }),
      status: 409,
      body: {
        success: false,
        error: { code: "Conflict", message: "Request conflicts", details: [], requestId: "old-request-id" },
      },
    };
    const { app, runs } = buildApp({ redis: redis.client, logger: logSink().logger }, { required: true });
    redis.store.set(`idem:POST /things:ip:::ffff:127.0.0.1:${KEY}`, JSON.stringify(stored));
    redis.store.set(`idem:POST /things:ip:127.0.0.1:${KEY}`, JSON.stringify(stored));

    const response = await request(app).post("/things").set("Idempotency-Key", KEY).send({ a: 1 });
    const body = response.body as { error: { requestId: string; code: string } };

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("Conflict");
    expect(body.error.requestId).toBe(REQUEST_ID);
    expect(runs()).toBe(0);
  });

  it("should respond 422 IdempotencyConflict when the same key arrives with a different body", async () => {
    const redis = fakeRedis();
    const { app, runs } = buildApp({ redis: redis.client, logger: logSink().logger }, { required: true });

    await request(app).post("/things").set("Idempotency-Key", KEY).send({ a: 1 });
    await flush();
    const response = await request(app).post("/things").set("Idempotency-Key", KEY).send({ a: 2 });
    const body = response.body as { code: string };

    expect(response.status).toBe(422);
    expect(body.code).toBe("IdempotencyConflict");
    expect(runs()).toBe(1);
  });

  it("should respond 409 Conflict with Retry-After 1 when the same key and body are still in flight", async () => {
    const redis = fakeRedis();
    const slow: RequestHandler = (_req, res) => {
      setTimeout(() => {
        res.status(201).json({ success: true, data: { ok: true } });
      }, 80);
    };
    const { app } = buildApp({ redis: redis.client, logger: logSink().logger }, { required: true }, slow);

    const [first, second] = await Promise.all([
      request(app).post("/things").set("Idempotency-Key", KEY).send({ a: 1 }),
      delay(20).then(() => request(app).post("/things").set("Idempotency-Key", KEY).send({ a: 1 })),
    ]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect((second.body as { code: string }).code).toBe("Conflict");
    expect(second.headers["retry-after"]).toBe("1");
  });

  it("should treat bodies as identical when only key order differs", () => {
    expect(hashBody({ a: 1, b: { c: 2, d: 3 } })).toBe(hashBody({ b: { d: 3, c: 2 }, a: 1 }));
    expect(hashBody({ a: 1 })).not.toBe(hashBody({ a: 2 }));
    expect(hashBody(undefined)).toBe(hashBody(null));
  });

  it("should build idem:<METHOD> <concrete path>:<principal>:<key> without the query string when composing the Redis key", () => {
    const req = {
      method: "POST",
      baseUrl: "/api",
      path: "/auth/register/complete",
      url: "/auth/register/complete?debug=1",
      ip: "203.0.113.7",
      socket: { remoteAddress: "203.0.113.7" },
    } as unknown as Request;

    expect(idempotencyKey(req, KEY)).toBe(`idem:POST /api/auth/register/complete:ip:203.0.113.7:${KEY}`);
  });

  it("should key by the principal when the request is authenticated", () => {
    const base = {
      method: "PATCH",
      baseUrl: "/internal",
      path: "/users/42/status",
      ip: "203.0.113.7",
      socket: { remoteAddress: "203.0.113.7" },
    };
    const userReq = { ...base, auth: { kind: "user", userId: 7 } } as unknown as Request;
    const serviceReq = { ...base, auth: { kind: "service", clientId: "care-service" } } as unknown as Request;

    expect(idempotencyKey(userReq, KEY)).toBe(`idem:PATCH /internal/users/42/status:user:7:${KEY}`);
    expect(idempotencyKey(serviceReq, KEY)).toBe(
      `idem:PATCH /internal/users/42/status:client:care-service:${KEY}`,
    );
  });

  it("should produce different keys when the same Idempotency-Key targets two different resource ids", () => {
    const first = { method: "POST", baseUrl: "/api", path: "/things/1", ip: "203.0.113.7", socket: {} } as unknown as Request;
    const second = { method: "POST", baseUrl: "/api", path: "/things/2", ip: "203.0.113.7", socket: {} } as unknown as Request;

    expect(idempotencyKey(first, KEY)).not.toBe(idempotencyKey(second, KEY));
  });

  it("should not replay across resources when the same key is sent to two ids", async () => {
    const redis = fakeRedis();
    const { app, runs } = buildApp({ redis: redis.client, logger: logSink().logger }, { required: true });

    const first = await request(app).post("/things/1").set("Idempotency-Key", KEY).send({ a: 1 });
    await flush();
    const second = await request(app).post("/things/2").set("Idempotency-Key", KEY).send({ a: 1 });
    await flush();

    expect((first.body as { data: { id: string } }).data.id).toBe("1");
    expect((second.body as { data: { id: string } }).data.id).toBe("2");
    expect(runs()).toBe(2);
  });

  it("should claim again when the record vanished between SET NX and GET", async () => {
    const redis = fakeRedis();
    redis.get.mockImplementationOnce(() => Promise.resolve(null));
    redis.set.mockImplementationOnce(() => Promise.resolve(null));
    const { app, runs } = buildApp({ redis: redis.client, logger: logSink().logger }, { required: true });

    const response = await request(app).post("/things").set("Idempotency-Key", KEY).send({ a: 1 });

    expect(response.status).toBe(201);
    expect(runs()).toBe(1);
    expect(redis.del).toHaveBeenCalled();
  });
});
