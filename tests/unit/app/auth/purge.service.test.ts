import type { Knex } from "knex";
import { PurgeService } from "../../../../src/app/auth/service/purge.service";
import { Logger } from "../../../../src/lib/logger/logger";
import type { MockedModule } from "../../../helpers/types";

jest.mock("../../../../src/lib/knex/advisory-lock", () => ({ withAdvisoryXactLock: jest.fn() }));
jest.mock("../../../../src/app/auth/repository/refresh-token.repo", () => ({
  deleteExpiredBatch: jest.fn(),
}));
jest.mock("../../../../src/app/auth/repository/password-reset.repo", () => ({
  deleteOldBatch: jest.fn(),
}));
jest.mock("../../../../src/app/auth/repository/registration-challenge.repo", () => ({
  deleteOldBatch: jest.fn(),
}));
jest.mock("../../../../src/lib/outbox/outbox.repo", () => ({ deleteFinishedBatch: jest.fn() }));

const lock = jest.requireMock("../../../../src/lib/knex/advisory-lock") as MockedModule<
  typeof import("../../../../src/lib/knex/advisory-lock")
>;
const refreshTokens = jest.requireMock(
  "../../../../src/app/auth/repository/refresh-token.repo",
) as MockedModule<typeof import("../../../../src/app/auth/repository/refresh-token.repo")>;
const outbox = jest.requireMock("../../../../src/lib/outbox/outbox.repo") as MockedModule<
  typeof import("../../../../src/lib/outbox/outbox.repo")
>;

function logSink(): { logger: Logger; lines: () => Record<string, unknown>[] } {
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
  };
}

const db = {} as Knex;
let sink: ReturnType<typeof logSink>;
let service: PurgeService;

beforeEach(() => {
  sink = logSink();
  service = new PurgeService(db, sink.logger);
  refreshTokens.deleteExpiredBatch.mockResolvedValue(0);
  outbox.deleteFinishedBatch.mockResolvedValue(0);
});

/** Runs the caller's batch callback under a granted lock and reports what it deleted. */
function grantLock(deleted: number[] | number): void {
  const queue = Array.isArray(deleted) ? [...deleted] : undefined;
  lock.withAdvisoryXactLock.mockImplementation(
    async (_db: unknown, _key: bigint, fn: (trx: unknown) => Promise<number>) => {
      const result = await fn({});
      if (queue !== undefined) {
        return queue.shift() ?? 0;
      }
      return typeof deleted === "number" ? deleted : result;
    },
  );
}

describe("PurgeService.runAll", () => {
  it("should purge each retention table once under its own advisory lock when nothing is left over", async () => {
    grantLock(0);

    const results = await service.runAll(new AbortController().signal);

    expect(results.map((result) => result.table)).toEqual([
      "refresh_tokens",
      "password_resets",
      "registration_challenges",
      "outbox_jobs_done",
      "outbox_jobs_dead",
    ]);
    expect(lock.withAdvisoryXactLock).toHaveBeenCalledTimes(5);
    const keys = lock.withAdvisoryXactLock.mock.calls.map((call) => call[1] as bigint);
    expect(new Set(keys).size).toBe(5);
  });

  it("should use the documented retention windows for the outbox batches", async () => {
    grantLock(0);

    await service.runAll(new AbortController().signal);

    expect(outbox.deleteFinishedBatch).toHaveBeenCalledWith("done", 7, 5000, expect.anything());
    expect(outbox.deleteFinishedBatch).toHaveBeenCalledWith("dead", 30, 5000, expect.anything());
  });

  it("should keep purging while a batch comes back full and stop on the first short batch", async () => {
    grantLock([5000, 5000, 12, 0, 0, 0, 0]);

    const results = await service.runAll(new AbortController().signal);

    expect(results[0]).toEqual({ table: "refresh_tokens", deleted: 10_012 });
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "purge_completed", table: "refresh_tokens", deleted: 10_012, batches: 3 }),
    );
  });

  it("should stop after the batch ceiling when rows keep coming", async () => {
    grantLock(5000);

    const results = await service.runAll(new AbortController().signal);

    expect(results[0]).toEqual({ table: "refresh_tokens", deleted: 100_000 });
  });

  it("should leave the rest to the other worker when the advisory lock is not granted", async () => {
    lock.withAdvisoryXactLock.mockResolvedValue(undefined);

    const results = await service.runAll(new AbortController().signal);

    expect(results.every((result) => result.deleted === 0)).toBe(true);
    expect(refreshTokens.deleteExpiredBatch).not.toHaveBeenCalled();
    expect(sink.lines().filter((line) => line.message === "purge_completed")).toHaveLength(0);
  });

  it("should stop purging when the shutdown signal has fired", async () => {
    grantLock(5000);
    const controller = new AbortController();
    controller.abort();

    const results = await service.runAll(controller.signal);

    expect(lock.withAdvisoryXactLock).not.toHaveBeenCalled();
    expect(results).toHaveLength(5);
  });

  it("should never purge the users table when every step runs", async () => {
    grantLock(0);

    const results = await service.runAll(new AbortController().signal);

    expect(results.map((result) => result.table)).not.toContain("users");
  });
});
