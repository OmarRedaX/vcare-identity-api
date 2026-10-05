import type { Knex } from "knex";
import { Logger } from "../../../../src/lib/logger/logger";
import { OutboxDeliveryError } from "../../../../src/lib/outbox/delivery-error";
import { OutboxProcessor } from "../../../../src/lib/outbox/outbox-processor";
import { getRequestContext } from "../../../../src/lib/request-id/context";
import type { JobHandler, OutboxJob, OutboxJobType } from "../../../../src/lib/outbox/types";

jest.mock("../../../../src/lib/outbox/outbox.repo", () => ({
  claim: jest.fn(),
  reclaimExpiredLeases: jest.fn(),
  markDone: jest.fn(),
  markRetry: jest.fn(),
  markDead: jest.fn(),
  oldestDuePendingAgeSeconds: jest.fn(),
}));

const repo = jest.requireMock<{
  claim: jest.Mock;
  reclaimExpiredLeases: jest.Mock;
  markDone: jest.Mock;
  markRetry: jest.Mock;
  markDead: jest.Mock;
  oldestDuePendingAgeSeconds: jest.Mock;
}>("../../../../src/lib/outbox/outbox.repo");

const REQUEST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function job(overrides: Partial<OutboxJob> = {}): OutboxJob {
  return {
    id: 1,
    type: "send_registration_code",
    aggregateId: 10,
    attempts: 1,
    requestId: REQUEST_ID,
    ...overrides,
  };
}

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

function build(
  handler: JobHandler,
  sink: ReturnType<typeof logSink>,
  options?: { maxAttempts?: number; concurrency?: number },
): OutboxProcessor {
  const handlers = new Map<OutboxJobType, JobHandler>([["send_registration_code", handler]]);
  return new OutboxProcessor({
    db,
    logger: sink.logger,
    handlers,
    batchSize: 20,
    maxAttempts: options?.maxAttempts ?? 8,
    concurrency: options?.concurrency,
  });
}

let sink: ReturnType<typeof logSink>;

beforeEach(() => {
  sink = logSink();
  repo.reclaimExpiredLeases.mockResolvedValue(0);
  repo.claim.mockResolvedValue([]);
  repo.markDone.mockResolvedValue(1);
  repo.markRetry.mockResolvedValue(1);
  repo.markDead.mockResolvedValue(1);
  repo.oldestDuePendingAgeSeconds.mockResolvedValue(0);
});

describe("OutboxProcessor.tick", () => {
  it("should reclaim expired leases and warn when a previous worker died mid-job", async () => {
    repo.reclaimExpiredLeases.mockResolvedValue(3);

    await build(() => Promise.resolve("sent"), sink).tick(new AbortController().signal);

    expect(repo.reclaimExpiredLeases).toHaveBeenCalledWith(20, 8, db);
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "outbox_lease_reclaimed", count: 3 }),
    );
  });

  it("should mark a job done and log outbox_job_sent when the handler reports sent", async () => {
    repo.claim.mockResolvedValue([job()]);

    await build(() => Promise.resolve("sent"), sink).tick(new AbortController().signal);

    expect(repo.markDone).toHaveBeenCalledWith(1, db);
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "outbox_job_sent", jobId: 1, attempts: 1 }),
    );
  });

  it("should mark a job done and log outbox_job_skipped when the handler reports skipped", async () => {
    repo.claim.mockResolvedValue([job()]);

    await build(() => Promise.resolve("skipped"), sink).tick(new AbortController().signal);

    expect(repo.markDone).toHaveBeenCalledWith(1, db);
    expect(sink.lines()).toContainEqual(expect.objectContaining({ message: "outbox_job_skipped", jobId: 1 }));
  });

  it("should not re-queue the job when markDone fails after a successful send", async () => {
    repo.claim.mockResolvedValue([job()]);
    repo.markDone.mockRejectedValue(new Error("connection lost"));

    await expect(build(() => Promise.resolve("sent"), sink).tick(new AbortController().signal)).resolves.not.toThrow();

    expect(repo.markRetry).not.toHaveBeenCalled();
    expect(repo.markDead).not.toHaveBeenCalled();
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "outbox_job_bookkeeping_failed", jobId: 1 }),
    );
  });

  it("should finish the rest of the batch when markRetry throws for one job", async () => {
    repo.claim.mockResolvedValue([job({ id: 1 }), job({ id: 2 })]);
    repo.markRetry.mockRejectedValue(new Error("connection lost"));
    const handler: JobHandler = (queued) =>
      queued.id === 1 ? Promise.reject(new OutboxDeliveryError("EmailTimeout", true)) : Promise.resolve("sent");

    await expect(build(handler, sink, { concurrency: 1 }).tick(new AbortController().signal)).resolves.not.toThrow();

    expect(repo.markDone).toHaveBeenCalledWith(2, db);
  });

  it("should schedule a backed-off retry when the failure is retryable and attempts remain", async () => {
    repo.claim.mockResolvedValue([job({ attempts: 2 })]);

    await build(() => Promise.reject(new OutboxDeliveryError("EmailTimeout", true)), sink).tick(
      new AbortController().signal,
    );

    expect(repo.markRetry).toHaveBeenCalledWith(1, 60, "EmailTimeout", db);
    expect(repo.markDead).not.toHaveBeenCalled();
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "outbox_job_retry", errorClass: "EmailTimeout" }),
    );
  });

  it("should mark dead immediately when the failure is not retryable", async () => {
    repo.claim.mockResolvedValue([job()]);

    await build(() => Promise.reject(new OutboxDeliveryError("EmailRejected", false)), sink).tick(
      new AbortController().signal,
    );

    expect(repo.markDead).toHaveBeenCalledWith(1, "EmailRejected", db);
    expect(repo.markRetry).not.toHaveBeenCalled();
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "outbox_job_dead", errorClass: "EmailRejected" }),
    );
    expect(sink.lines()).toContainEqual(expect.objectContaining({ outbox_dead_jobs: 1 }));
  });

  it("should mark dead when a retryable failure has exhausted the attempt budget", async () => {
    repo.claim.mockResolvedValue([job({ attempts: 8 })]);

    await build(() => Promise.reject(new OutboxDeliveryError("EmailTimeout", true)), sink, {
      maxAttempts: 8,
    }).tick(new AbortController().signal);

    expect(repo.markDead).toHaveBeenCalledWith(1, "EmailTimeout", db);
  });

  it("should treat an unexpected error as retryable and record only its class name", async () => {
    repo.claim.mockResolvedValue([job()]);

    await build(() => Promise.reject(new TypeError("amira@example.test is not a function")), sink).tick(
      new AbortController().signal,
    );

    expect(repo.markRetry).toHaveBeenCalledWith(1, 30, "TypeError", db);
    expect(JSON.stringify(sink.lines())).not.toContain("amira@example.test");
  });

  it("should mark dead with UnknownJobType when no handler is registered for the type", async () => {
    repo.claim.mockResolvedValue([job({ type: "send_password_reset" })]);

    await build(() => Promise.resolve("sent"), sink).tick(new AbortController().signal);

    expect(repo.markDead).toHaveBeenCalledWith(1, "UnknownJobType", db);
  });

  it("should run the handler inside the job's originating request id", async () => {
    repo.claim.mockResolvedValue([job()]);
    let seen: string | undefined;

    await build(() => {
      seen = getRequestContext()?.requestId;
      return Promise.resolve("sent");
    }, sink).tick(new AbortController().signal);

    expect(seen).toBe(REQUEST_ID);
    expect(sink.lines().find((line) => line.message === "outbox_job_sent")?.requestId).toBe(REQUEST_ID);
  });

  it("should stop starting new jobs when the shutdown signal fires", async () => {
    const controller = new AbortController();
    repo.claim.mockResolvedValue([job({ id: 1 }), job({ id: 2 }), job({ id: 3 })]);
    const started: number[] = [];

    await build(
      (claimed) => {
        started.push(claimed.id);
        controller.abort();
        return Promise.resolve("sent");
      },
      sink,
      { concurrency: 1 },
    ).tick(controller.signal);

    expect(started).toEqual([1]);
    expect(repo.markDone).toHaveBeenCalledTimes(1);
  });

  it("should report the oldest pending age as a metric when a tick runs", async () => {
    repo.oldestDuePendingAgeSeconds.mockResolvedValue(12);

    await build(() => Promise.resolve("sent"), sink).tick(new AbortController().signal);

    expect(sink.lines()).toContainEqual(expect.objectContaining({ outbox_oldest_pending_age_s: 12 }));
  });

  it("should not claim or finish anything when no job is due", async () => {
    await build(() => Promise.resolve("sent"), sink).tick(new AbortController().signal);

    expect(repo.markDone).not.toHaveBeenCalled();
    expect(repo.markRetry).not.toHaveBeenCalled();
    expect(repo.markDead).not.toHaveBeenCalled();
  });
});
