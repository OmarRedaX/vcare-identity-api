import { createHash, randomUUID } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import type Redis from "ioredis";
import { toMs } from "../../pkg/utils/time";
import { IdempotencyConflict, IdempotencyInProgress, ValidationFailed } from "../error/errors";
import { clientIp } from "../http/client-ip";
import { captureRoute } from "../http/route-capture";
import { logger as defaultLogger } from "../logger/logger";
import { UUID_PATTERN } from "../request-id/request-id";
import { redis as defaultRedis } from "../redis/redis";
import { guardedRedisCall, redisUsable } from "../redis/redis-guard";
import type { IdempotencyDeps, IdempotencyOptions, IdempotencyRecord } from "./types";

export const IDEMPOTENCY_TTL_MS = toMs(24, "h");
export const IN_FLIGHT_TTL_MS = toMs(60, "s");
export const IDEMPOTENCY_REDIS_TIMEOUT_MS = 100;

const HEADER = "idempotency-key";

/** Deletes the key only while it still holds the exact in-flight payload this request wrote. */
const RELEASE_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";

/** Stable JSON so that key order never changes the hash. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(",")}}`;
}

export function hashBody(body: unknown): string {
  return createHash("sha256").update(stableStringify(body === undefined ? null : body)).digest("hex");
}

/**
 * `idem:<METHOD> <concrete path>:<principal>:<key>` — the concrete path (never the route pattern, never the
 * query string), identical in care-service (spec §12).
 */
export function idempotencyKey(req: Request, key: string): string {
  const route = `${req.method} ${req.baseUrl}${req.path}`;
  const auth = req.auth;
  const principal =
    auth?.kind === "user"
      ? `user:${auth.userId}`
      : auth?.kind === "service"
        ? `client:${auth.clientId}`
        : `ip:${clientIp(req)}`;
  return `idem:${route}:${principal}:${key}`;
}

function parseRecord(raw: string | null): IdempotencyRecord | undefined {
  if (raw === null) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as IdempotencyRecord).v === 1 &&
      typeof (parsed as IdempotencyRecord).bodyHash === "string"
    ) {
      return parsed as IdempotencyRecord;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function withCurrentRequestId(body: unknown, requestId: string): unknown {
  if (
    typeof body === "object" &&
    body !== null &&
    (body as Record<string, unknown>).success === false &&
    typeof (body as Record<string, unknown>).error === "object"
  ) {
    const clone = { ...(body as Record<string, unknown>) };
    clone.error = { ...(clone.error as Record<string, unknown>), requestId };
    return clone;
  }
  return body;
}

function captureResponse(
  res: Response,
  onComplete: (status: number, body: unknown, clientClosed: boolean) => void,
): void {
  let captured: unknown = null;

  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    captured = body;
    return originalJson(body);
  }) as typeof res.json;

  const originalSend = res.send.bind(res);
  res.send = ((body?: unknown) => {
    if (captured === null) {
      captured = body ?? null;
    }
    return originalSend(body);
  }) as typeof res.send;

  let done = false;
  const complete = (clientClosed: boolean): void => {
    if (done) {
      return;
    }
    done = true;
    onComplete(res.statusCode, captured, clientClosed);
  };

  res.on("finish", () => {
    complete(false);
  });
  res.on("close", () => {
    complete(!res.writableEnded);
  });
}

/**
 * Route-level, after guard and authorize (CLAUDE.md -> Module file conventions, item 7).
 * A Redis outage skips the middleware — database constraints stop duplicates (ADR 0008).
 */
export function idempotency(options: IdempotencyOptions, deps?: IdempotencyDeps): RequestHandler {
  const resolved: IdempotencyDeps = deps ?? { redis: defaultRedis, logger: defaultLogger };

  const skip = (reason: string, next: Parameters<RequestHandler>[2]): void => {
    resolved.logger.warn("idempotency_skipped", { reason });
    next();
  };

  const store = async (client: Redis, key: string, record: IdempotencyRecord, ttlMs: number): Promise<void> => {
    await client.set(key, JSON.stringify(record), "PX", ttlMs);
  };

  return (req, res, next) => {
    captureRoute(req, res);

    const header = req.headers[HEADER];
    if (header === undefined) {
      if (options.required) {
        next(ValidationFailed.withDetails([{ field: "Idempotency-Key", issue: "is required" }]));
        return;
      }
      next();
      return;
    }

    if (typeof header !== "string" || !UUID_PATTERN.test(header)) {
      next(ValidationFailed.withDetails([{ field: "Idempotency-Key", issue: "must be a UUID" }]));
      return;
    }

    if (!redisUsable(resolved.redis)) {
      skip("redis_unavailable", next);
      return;
    }

    const client = resolved.redis;
    const key = idempotencyKey(req, header.toLowerCase());
    const bodyHash = hashBody(req.body as unknown);

    const run = async (): Promise<void> => {
      const claim = async (): Promise<boolean> => {
        const record: IdempotencyRecord = { v: 1, state: "in_flight", bodyHash, nonce: randomUUID() };
        const payload = JSON.stringify(record);
        const pending = client.set(key, payload, "PX", IN_FLIGHT_TTL_MS, "NX");
        try {
          const reply = await guardedRedisCall(client, pending, IDEMPOTENCY_REDIS_TIMEOUT_MS);
          return reply === "OK";
        } catch (err) {
          // The SET cannot be cancelled: if it lands after we gave up, remove our own orphan record
          // (compare-and-delete on the exact payload) so same-key retries are not answered 409.
          pending.then(
            (late) => {
              if (late === "OK") {
                client.eval(RELEASE_SCRIPT, 1, key, payload).catch(() => undefined);
              }
            },
            () => undefined,
          );
          throw err;
        }
      };

      const beginHandler = (): void => {
        captureResponse(res, (status, body, clientClosed) => {
          // 429 is a transient refusal (e.g. HashQueueFull), not the request's outcome: never replay it.
          if (clientClosed || status >= 500 || status === 429) {
            client.del(key).catch(() => undefined);
            return;
          }
          store(client, key, { v: 1, state: "completed", bodyHash, status, body }, IDEMPOTENCY_TTL_MS).catch(
            () => {
              resolved.logger.warn("idempotency_store_failed");
            },
          );
        });
        next();
      };

      if (await claim()) {
        beginHandler();
        return;
      }

      const existing = parseRecord(
        await guardedRedisCall(client, client.get(key), IDEMPOTENCY_REDIS_TIMEOUT_MS),
      );

      if (existing === undefined) {
        // Expired or unparsable between SET NX and GET: drop it and try to claim once more.
        await guardedRedisCall(client, client.del(key), IDEMPOTENCY_REDIS_TIMEOUT_MS);
        if (await claim()) {
          beginHandler();
          return;
        }
        res.setHeader("Retry-After", "1");
        next(IdempotencyInProgress);
        return;
      }

      if (existing.bodyHash !== bodyHash) {
        next(IdempotencyConflict);
        return;
      }

      if (existing.state === "completed") {
        const status = existing.status ?? 200;
        res.status(status);
        if (existing.body === null || existing.body === undefined) {
          res.end();
          return;
        }
        res.json(withCurrentRequestId(existing.body, req.requestId));
        return;
      }

      res.setHeader("Retry-After", "1");
      next(IdempotencyInProgress);
    };

    run().catch(() => {
      skip("redis_error", next);
    });
  };
}
