import type { Express } from "express";
import { decodeCursor } from "../../../src/lib/http/pagination/cursor";
import { db } from "../../../src/lib/knex/knex";
import { buildTestApps } from "../../helpers/app";
import { seedUser, softDelete } from "../../helpers/auth";
import {
  expectContractDeclares,
  expectErrorEnvelope,
  expectPaginationMeta,
  expectSuccessEnvelope,
  expectUserPayload,
} from "../../helpers/contract";
import { closeDb, truncateAll } from "../../helpers/db";
import { captureLogs } from "../../helpers/log-capture";
import { closeRedis, flushTestKeys } from "../../helpers/redis";
import { listUsers, SECRET_MARKERS, seedAdmin, insertUserRows, type Admin } from "../../helpers/users";
import { logger } from "../../../src/lib/logger/logger";

let apps: { publicApp: Express; internalApp: Express };
let admin: Admin;

interface Page {
  ids: number[];
  meta: { nextCursor: string | null; hasMore: boolean; count: number };
}

async function fetchPage(query: Record<string, string>): Promise<Page> {
  const response = await listUsers(apps.publicApp, admin.token, query);
  expect(response.status).toBe(200);
  const data = expectSuccessEnvelope(response.body) as { id: number }[];
  const meta = expectPaginationMeta((response.body as { meta: unknown }).meta);
  expect(meta.count).toBe(data.length);
  return { ids: data.map((row) => row.id), meta };
}

/** Follows nextCursor to the end and returns every id in the order served. */
async function walk(limit: number, extra: Record<string, string> = {}): Promise<{ ids: number[]; pages: number }> {
  const ids: number[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const query: Record<string, string> = { limit: String(limit), ...extra };
    if (cursor !== undefined) {
      query.cursor = cursor;
    }
    const page = await fetchPage(query);
    ids.push(...page.ids);
    cursor = page.meta.nextCursor ?? undefined;
    pages += 1;
    expect(pages).toBeLessThan(100);
  } while (cursor !== undefined);
  return { ids, pages };
}

async function referenceOrder(where = ""): Promise<number[]> {
  const result = await db.raw<{ rows: { id: string }[] }>(
    `SELECT id FROM users WHERE deleted_at IS NULL ${where} ORDER BY created_at DESC, id DESC`,
  );
  return result.rows.map((row) => Number(row.id));
}

beforeAll(() => {
  apps = buildTestApps();
});

beforeEach(async () => {
  await truncateAll();
  await flushTestKeys();
  admin = await seedAdmin();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("GET /api/users: contract", () => {
  it("should return the success envelope, User items, PaginationMeta and no-store when the admin lists users", async () => {
    await seedUser({ email: "amira.patient@example.test", phone: "+201000000001" });

    const response = await listUsers(apps.publicApp, admin.token);

    expect(response.status).toBe(200);
    expectContractDeclares("/api/users", "get", 200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const data = expectSuccessEnvelope(response.body) as Record<string, unknown>[];
    expect(data).toHaveLength(2);
    for (const item of data) {
      expectUserPayload(item);
    }
    expect(expectPaginationMeta((response.body as { meta: unknown }).meta)).toEqual({
      nextCursor: null,
      hasMore: false,
      count: 2,
    });
  });

  it("should echo an incoming X-Request-Id and put the same id in an error envelope", async () => {
    const id = "7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b";

    const ok = await listUsers(apps.publicApp, admin.token).set("X-Request-Id", id);
    const bad = await listUsers(apps.publicApp, admin.token, { limit: "0" }).set("X-Request-Id", id);

    expect(ok.headers["x-request-id"]).toBe(id);
    expect((bad.body as { error: { requestId: string } }).error.requestId).toBe(id);
  });

  it("should never carry a password hash, token hash or deletedAt in the body", async () => {
    await seedUser({ email: "secrets.patient@example.test" });
    const stored = await db("users").select("password_hash").where("id", ">", 0);
    const hashes = (stored as { password_hash: string }[]).map((row) => row.password_hash);

    const response = await listUsers(apps.publicApp, admin.token);

    const text = JSON.stringify(response.body);
    for (const marker of SECRET_MARKERS) {
      expect(text).not.toContain(marker);
    }
    for (const hash of hashes) {
      expect(text).not.toContain(hash);
    }
  });

  it("should expose email and phone to the admin because the contract's User shape includes them", async () => {
    await seedUser({ email: "contact.patient@example.test", phone: "+201000000009" });

    const response = await listUsers(apps.publicApp, admin.token, { email: "contact.patient@example.test" });

    expect((response.body as { data: { phone: string }[] }).data[0]?.phone).toBe("+201000000009");
  });
});

describe("GET /api/users: pagination (BR-15)", () => {
  it("should default to 20 per page, newest first, and reach page 2 on the default sort", async () => {
    await insertUserRows(
      Array.from({ length: 24 }, (_, index) => ({
        email: `patient${String(index).padStart(2, "0")}@example.test`,
        createdAt: `2026-02-01T00:00:${String(index).padStart(2, "0")}.000000Z`,
      })),
    );

    const first = await fetchPage({});
    expect(first.meta.count).toBe(20);
    expect(first.meta.hasMore).toBe(true);
    expect(first.meta.nextCursor).not.toBeNull();

    const second = await fetchPage({ cursor: first.meta.nextCursor ?? "" });
    expect(second.meta).toEqual({ nextCursor: null, hasMore: false, count: 5 });
    expect([...first.ids, ...second.ids]).toEqual(await referenceOrder());
  });

  it("should list the newest account first", async () => {
    const [older, newer] = await insertUserRows([
      { email: "older@example.test", createdAt: "2026-03-01T00:00:00.000000Z" },
      { email: "newer@example.test", createdAt: "2026-03-02T00:00:00.000000Z" },
    ]);

    const page = await fetchPage({ limit: "100" });

    expect(page.ids.indexOf(newer ?? 0)).toBeLessThan(page.ids.indexOf(older ?? 0));
    expect(page.ids[0]).toBe(admin.user.id);
  });

  it("should end exactly at the boundary: no cursor when rows equal the limit, a one-row page 2 when one more exists", async () => {
    await insertUserRows(
      Array.from({ length: 4 }, (_, index) => ({
        email: `boundary${String(index)}@example.test`,
        createdAt: `2026-02-01T00:00:0${String(index)}.000000Z`,
      })),
    );

    const exact = await fetchPage({ limit: "5" });
    expect(exact.meta).toEqual({ nextCursor: null, hasMore: false, count: 5 });

    const short = await fetchPage({ limit: "4" });
    expect(short.meta).toMatchObject({ hasMore: true, count: 4 });
    const last = await fetchPage({ limit: "4", cursor: short.meta.nextCursor ?? "" });
    expect(last.meta).toEqual({ nextCursor: null, hasMore: false, count: 1 });
  });

  it("should serve every row exactly once, in order, when rows share a millisecond and a microsecond", async () => {
    await insertUserRows([
      // Same millisecond, microseconds apart: a JS Date cursor would collapse these.
      { email: "us1@example.test", createdAt: "2026-01-01T00:00:00.123001Z" },
      { email: "us2@example.test", createdAt: "2026-01-01T00:00:00.123002Z" },
      { email: "us3@example.test", createdAt: "2026-01-01T00:00:00.123003Z" },
      { email: "us4@example.test", createdAt: "2026-01-01T00:00:00.123004Z" },
      { email: "us5@example.test", createdAt: "2026-01-01T00:00:00.123005Z" },
      // Same microsecond: the id tiebreak decides.
      { email: "tie1@example.test", createdAt: "2026-01-01T00:00:00.123003Z" },
      { email: "tie2@example.test", createdAt: "2026-01-01T00:00:00.123003Z" },
      { email: "tie3@example.test", createdAt: "2026-01-01T00:00:00.123003Z" },
    ]);

    for (const limit of [1, 2, 3, 4]) {
      const { ids } = await walk(limit);

      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(await referenceOrder());
      expect(ids).toHaveLength(9);
    }
  });

  it("should carry the microsecond text of created_at in nextCursor, never a millisecond-truncated value", async () => {
    await insertUserRows([
      { email: "p1@example.test", createdAt: "2026-01-01T00:00:00.123456Z" },
      { email: "p2@example.test", createdAt: "2026-01-01T00:00:00.123455Z" },
    ]);

    const page = await fetchPage({ limit: "2" });

    const decoded = decodeCursor(page.meta.nextCursor ?? "", "iso-timestamp");
    expect(decoded.v).toBe("2026-01-01T00:00:00.123456Z");
  });

  it("should page a filtered list without duplicates or gaps", async () => {
    await insertUserRows([
      ...Array.from({ length: 5 }, (_, index) => ({
        email: `doctor${String(index)}@example.test`,
        createdAt: "2026-01-01T00:00:00.500000Z",
        role: "doctor" as const,
        status: "pending" as const,
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        email: `patient${String(index)}@example.test`,
        createdAt: "2026-01-01T00:00:00.500000Z",
      })),
    ]);

    const { ids, pages } = await walk(2, { role: "doctor" });

    expect(pages).toBe(3);
    expect(ids).toEqual(await referenceOrder("AND role = 'doctor'"));
    expect(ids).toHaveLength(5);
  });

  it("should accept the maximum limit of 100", async () => {
    const page = await fetchPage({ limit: "100" });

    expect(page.meta.count).toBe(1);
  });
});

describe("GET /api/users: filters (BR-3, BR-16)", () => {
  beforeEach(async () => {
    await insertUserRows([
      { email: "amira.patient@example.test", createdAt: "2026-01-01T00:00:01.000000Z" },
      { email: "bassem.patient@example.test", createdAt: "2026-01-01T00:00:02.000000Z", status: "suspended" },
      { email: "dina.doctor@example.test", createdAt: "2026-01-01T00:00:03.000000Z", role: "doctor", status: "pending" },
      { email: "emad.doctor@example.test", createdAt: "2026-01-01T00:00:04.000000Z", role: "doctor", status: "active" },
      { email: "farida.doctor@example.test", createdAt: "2026-01-01T00:00:05.000000Z", role: "doctor", status: "rejected" },
    ]);
  });

  async function emails(query: Record<string, string>): Promise<string[]> {
    const response = await listUsers(apps.publicApp, admin.token, query);
    expect(response.status).toBe(200);
    return (response.body as { data: { email: string }[] }).data.map((row) => row.email).sort();
  }

  it("should return only doctors when role=doctor", async () => {
    expect(await emails({ role: "doctor" })).toEqual([
      "dina.doctor@example.test",
      "emad.doctor@example.test",
      "farida.doctor@example.test",
    ]);
  });

  it("should return only the admin when role=admin", async () => {
    expect(await emails({ role: "admin" })).toEqual([admin.user.email]);
  });

  it("should return only suspended accounts when status=suspended", async () => {
    expect(await emails({ status: "suspended" })).toEqual(["bassem.patient@example.test"]);
  });

  it("should combine role and status as an intersection", async () => {
    expect(await emails({ role: "doctor", status: "pending" })).toEqual(["dina.doctor@example.test"]);
    expect(await emails({ role: "patient", status: "pending" })).toEqual([]);
  });

  it("should match the email exactly and case-insensitively", async () => {
    expect(await emails({ email: "AMIRA.Patient@Example.TEST" })).toEqual(["amira.patient@example.test"]);
  });

  it("should not match an email by prefix or substring", async () => {
    expect(await emails({ email: "amira@example.test" })).toEqual([]);
    expect(await emails({ email: "mira.patient@example.test" })).toEqual([]);
  });

  it("should return an empty page with 200, not 404, when the email matches no live account", async () => {
    const response = await listUsers(apps.publicApp, admin.token, { email: "nobody@example.test" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: [],
      meta: { nextCursor: null, hasMore: false, count: 0 },
    });
  });

  it("should never list a soft-deleted user, with or without a filter", async () => {
    const victim = await seedUser({ email: "deleted.patient@example.test" });
    await softDelete(victim.id);

    expect(await emails({})).not.toContain("deleted.patient@example.test");
    expect(await emails({ role: "patient" })).not.toContain("deleted.patient@example.test");
    expect(await emails({ email: "deleted.patient@example.test" })).toEqual([]);
  });

  it("should list a new account that reuses the email of a soft-deleted one exactly once", async () => {
    const old = await seedUser({ email: "reuse.patient@example.test" });
    await softDelete(old.id);
    await seedUser({ email: "reuse.patient@example.test" });

    expect(await emails({ email: "reuse.patient@example.test" })).toEqual(["reuse.patient@example.test"]);
  });
});

describe("GET /api/users: validation", () => {
  it.each([
    ["role", { role: "superuser" }],
    ["status", { status: "deleted" }],
    ["email", { email: "not-an-email" }],
    ["limit", { limit: "0" }],
    ["limit", { limit: "101" }],
    ["limit", { limit: "abc" }],
    ["sort", { sort: "asc" }],
    ["deleted", { deleted: "true" }],
    ["cursor", { cursor: "not-a-cursor!!" }],
  ])("should answer 400 ValidationFailed naming %s when the query is %j", async (field, query) => {
    const response = await listUsers(apps.publicApp, admin.token, query);

    expect(response.status).toBe(400);
    expectContractDeclares("/api/users", "get", 400, "ValidationFailed");
    expectErrorEnvelope(response.body, "ValidationFailed");
    const details = (response.body as { error: { details: { field: string }[] } }).error.details;
    expect(details.map((detail) => detail.field)).toContain(field);
  });

  it("should answer 400 on field cursor when the cursor decodes but its sort value is not an instant or its id is not an integer", async () => {
    const forge = (payload: unknown): string => Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

    for (const cursor of [
      forge({ v: "yesterday", id: 3 }),
      forge({ v: "2026-01-01T00:00:00.000000Z", id: "3" }),
      forge({ v: "2026-01-01T00:00:00.000000Z", id: 0 }),
      forge({ v: "2026-01-01T00:00:00.000000Z", k: "8f1c4e2a-0000-4000-8000-000000000001" }),
      "a".repeat(513),
    ]) {
      const response = await listUsers(apps.publicApp, admin.token, { cursor });

      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, "ValidationFailed");
    }
  });

  it("should never echo the submitted email filter in the error envelope", async () => {
    const response = await listUsers(apps.publicApp, admin.token, { email: "private.person" });

    expect(JSON.stringify(response.body)).not.toContain("private.person");
  });
});

describe("GET /api/users: privacy (logs)", () => {
  it("should write no email filter, email, name or phone to the logs when the admin lists and filters users", async () => {
    await seedUser({ email: "logged.patient@example.test", fullName: "Layla Logfixture", phone: "+201000000077" });
    const capture = captureLogs();
    try {
      await listUsers(apps.publicApp, admin.token, { email: "logged.patient@example.test" });
      await listUsers(apps.publicApp, admin.token, { role: "patient", limit: "5" });

      const text = capture.text();
      expect(text).toContain("request_completed");
      expect(text).not.toContain("logged.patient@example.test");
      expect(text).not.toContain("Layla Logfixture");
      expect(text).not.toContain("+201000000077");
      expect(text).not.toContain(admin.token);
    } finally {
      capture.restore();
      logger.setLevel("warn");
    }
  });
});
