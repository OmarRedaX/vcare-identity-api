import { AppError } from "../../../../src/lib/error/AppError";
import {
  decodeCursor,
  decodeKeyCursor,
  encodeCursor,
  encodeKeyCursor,
} from "../../../../src/lib/http/pagination/cursor";
import { buildKeyPage } from "../../../../src/lib/http/pagination/page";

const FAMILY = "8f1c4e2a-0000-4000-8000-000000000001";
const INSTANT_US = "2026-10-07T12:00:00.123456Z";

function forge(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function expectInvalidCursor(run: () => unknown): void {
  let caught: unknown;
  try {
    run();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(AppError);
  const error = caught as AppError;
  expect(error.code).toBe("ValidationFailed");
  expect(error.status).toBe(400);
  expect(error.details).toEqual([{ field: "cursor", issue: "is invalid" }]);
}

describe("key cursor helpers", () => {
  it("should round-trip a microsecond instant and a family uuid", () => {
    expect(decodeKeyCursor(encodeKeyCursor({ v: INSTANT_US, k: FAMILY }))).toEqual({
      v: INSTANT_US,
      k: FAMILY,
    });
  });

  it("should accept instants with zero to six fractional digits and an explicit offset", () => {
    for (const v of [
      "2026-10-07T12:00:00Z",
      "2026-10-07T12:00:00.1Z",
      "2026-10-07T12:00:00.123Z",
      "2026-10-07T12:00:00.123456Z",
      "2026-10-07T12:00:00.123456+02:00",
    ]) {
      expect(decodeKeyCursor(encodeKeyCursor({ v, k: FAMILY })).v).toBe(v);
    }
  });

  it("should reject a seventh fractional digit because the database stores microseconds", () => {
    expectInvalidCursor(() => decodeKeyCursor(forge({ v: "2026-10-07T12:00:00.1234567Z", k: FAMILY })));
  });

  it("should reject an instant without an offset or that is not a date", () => {
    expectInvalidCursor(() => decodeKeyCursor(forge({ v: "2026-10-07T12:00:00", k: FAMILY })));
    expectInvalidCursor(() => decodeKeyCursor(forge({ v: "not-a-date", k: FAMILY })));
    expectInvalidCursor(() => decodeKeyCursor(forge({ v: "2026-13-45T99:00:00Z", k: FAMILY })));
    expectInvalidCursor(() => decodeKeyCursor(forge({ v: 1_790_000_000, k: FAMILY })));
  });

  it("should reject a tiebreaker that is not a uuid", () => {
    expectInvalidCursor(() => decodeKeyCursor(forge({ v: INSTANT_US, k: "42" })));
    expectInvalidCursor(() =>
      decodeKeyCursor(forge({ v: INSTANT_US, k: "8f1c4e2a-0000-4000-8000-00000000000g" })),
    );
    expectInvalidCursor(() => decodeKeyCursor(forge({ v: INSTANT_US, k: 42 })));
    expectInvalidCursor(() => decodeKeyCursor(forge({ v: INSTANT_US })));
  });

  it("should reject a cursor that is not base64url JSON, not an object, empty, or over 512 characters", () => {
    expectInvalidCursor(() => decodeKeyCursor("not-a-cursor!!"));
    expectInvalidCursor(() => decodeKeyCursor(forge([INSTANT_US, FAMILY])));
    expectInvalidCursor(() => decodeKeyCursor(forge(null)));
    expectInvalidCursor(() => decodeKeyCursor(""));
    expectInvalidCursor(() => decodeKeyCursor("a".repeat(513)));
  });
});

describe("user list cursor (iso-timestamp sort kind)", () => {
  it("should round-trip the microsecond text of created_at without truncating to milliseconds", () => {
    const decoded = decodeCursor(encodeCursor({ v: INSTANT_US, id: 9 }), "iso-timestamp");

    expect(decoded).toEqual({ v: INSTANT_US, id: 9 });
    // A JS Date would silently drop the last three digits: the reason the cursor carries text.
    expect(new Date(String(decoded.v)).toISOString()).toBe("2026-10-07T12:00:00.123Z");
    expect(new Date(String(decoded.v)).toISOString()).not.toBe(decoded.v);
  });

  it("should keep two instants that differ only in microseconds distinct", () => {
    const a = decodeCursor(encodeCursor({ v: "2026-10-07T12:00:00.123001Z", id: 1 }), "iso-timestamp");
    const b = decodeCursor(encodeCursor({ v: "2026-10-07T12:00:00.123002Z", id: 1 }), "iso-timestamp");

    expect(a.v).not.toBe(b.v);
  });
});

describe("buildKeyPage", () => {
  const rows = [
    { k: "8f1c4e2a-0000-4000-8000-000000000001", v: "2026-10-07T12:00:03.000003Z" },
    { k: "8f1c4e2a-0000-4000-8000-000000000002", v: "2026-10-07T12:00:02.000002Z" },
    { k: "8f1c4e2a-0000-4000-8000-000000000003", v: "2026-10-07T12:00:01.000001Z" },
  ];

  it("should trim to the limit and encode the last kept row when rows exceed the limit", () => {
    const page = buildKeyPage(rows, 2, (row) => ({ v: row.v, k: row.k }));

    expect(page.items).toEqual([rows[0], rows[1]]);
    expect(page.meta).toMatchObject({ hasMore: true, count: 2 });
    expect(decodeKeyCursor(page.meta.nextCursor ?? "")).toEqual({ v: rows[1]?.v, k: rows[1]?.k });
  });

  it("should return no cursor when rows equal the limit exactly (boundary)", () => {
    const page = buildKeyPage(rows, 3, (row) => ({ v: row.v, k: row.k }));

    expect(page.meta).toEqual({ nextCursor: null, hasMore: false, count: 3 });
  });

  it("should return an empty page when there are no rows", () => {
    const page = buildKeyPage([] as typeof rows, 20, (row) => ({ v: row.v, k: row.k }));

    expect(page.meta).toEqual({ nextCursor: null, hasMore: false, count: 0 });
  });
});
