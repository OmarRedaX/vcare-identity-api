import { AppError } from "../../../../src/lib/error/AppError";
import { decodeCursor, encodeCursor } from "../../../../src/lib/http/pagination/cursor";
import { buildPage } from "../../../../src/lib/http/pagination/page";

interface Row {
  id: number;
  name: string;
}

const ROWS: Row[] = [
  { id: 1, name: "a" },
  { id: 2, name: "b" },
  { id: 3, name: "c" },
];

function expectValidationFailedOnCursor(run: () => unknown): void {
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

describe("cursor", () => {
  it("should round-trip the sort value and id when a cursor is encoded then decoded", () => {
    expect(decodeCursor(encodeCursor({ v: "2026-09-16T00:00:00.000Z", id: 42 }))).toEqual({
      v: "2026-09-16T00:00:00.000Z",
      id: 42,
    });
    expect(decodeCursor(encodeCursor({ v: 17, id: 1 }))).toEqual({ v: 17, id: 1 });
  });

  it("should throw ValidationFailed on field cursor when the cursor is not base64url JSON", () => {
    expectValidationFailedOnCursor(() => decodeCursor("not-a-cursor!!"));
  });

  it("should throw ValidationFailed on field cursor when the id is not a positive integer", () => {
    expectValidationFailedOnCursor(() =>
      decodeCursor(Buffer.from(JSON.stringify({ v: "a", id: 0 }), "utf8").toString("base64url")),
    );
    expectValidationFailedOnCursor(() =>
      decodeCursor(Buffer.from(JSON.stringify({ v: "a", id: 1.5 }), "utf8").toString("base64url")),
    );
    expectValidationFailedOnCursor(() =>
      decodeCursor(Buffer.from(JSON.stringify({ id: 3 }), "utf8").toString("base64url")),
    );
  });

  it("should throw ValidationFailed on field cursor when the cursor is longer than 512 characters", () => {
    expectValidationFailedOnCursor(() => decodeCursor("a".repeat(513)));
  });
});

describe("buildPage", () => {
  it("should return hasMore true and a nextCursor when rows exceed the limit", () => {
    const page = buildPage(ROWS, 2, (row) => ({ v: row.name, id: row.id }));

    expect(page.items).toEqual([ROWS[0], ROWS[1]]);
    expect(page.meta.hasMore).toBe(true);
    expect(page.meta.count).toBe(2);
    expect(page.meta.nextCursor).not.toBeNull();
    expect(decodeCursor(page.meta.nextCursor ?? "")).toEqual({ v: "b", id: 2 });
  });

  it("should return nextCursor null and hasMore false when rows do not exceed the limit", () => {
    const page = buildPage(ROWS, 3, (row) => ({ v: row.name, id: row.id }));

    expect(page.items).toHaveLength(3);
    expect(page.meta.hasMore).toBe(false);
    expect(page.meta.nextCursor).toBeNull();
    expect(page.meta.count).toBe(3);
  });

  it("should return an empty page when there are no rows", () => {
    const page = buildPage<Row>([], 20, (row) => ({ v: row.name, id: row.id }));

    expect(page.items).toEqual([]);
    expect(page.meta).toEqual({ nextCursor: null, hasMore: false, count: 0 });
  });
});

describe("decodeCursor sort kinds", () => {
  const forge = (v: unknown): string => Buffer.from(JSON.stringify({ v, id: 1 }), "utf8").toString("base64url");

  it("should throw ValidationFailed on cursor when a timestamp sort receives a non-ISO value", () => {
    expectValidationFailedOnCursor(() => decodeCursor(forge("abc"), "iso-timestamp"));
    expectValidationFailedOnCursor(() => decodeCursor(forge(5), "iso-timestamp"));
  });

  it("should accept an ISO-8601 instant when a timestamp sort is requested", () => {
    expect(decodeCursor(forge("2026-09-16T00:00:00.123Z"), "iso-timestamp").v).toBe("2026-09-16T00:00:00.123Z");
  });

  it("should throw ValidationFailed on cursor when a numeric sort receives a string", () => {
    expectValidationFailedOnCursor(() => decodeCursor(forge("1"), "number"));
  });
});
