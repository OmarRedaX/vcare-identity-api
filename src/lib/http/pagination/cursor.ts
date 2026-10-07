import { ValidationFailed } from "../../error/errors";
import type { CursorPayload, CursorSortKind, KeyCursorPayload } from "./types";

const MAX_CURSOR_LENGTH = 512;
// ISO-8601 instant with an explicit offset, e.g. 2026-09-16T00:00:00.123Z or ...+02:00.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

function invalid(): never {
  throw ValidationFailed.withDetails([{ field: "cursor", issue: "is invalid" }]);
}

/** Keyset cursor: the sort value plus the id, so ties are stable (CLAUDE.md -> API conventions). */
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string, sortKind: CursorSortKind = "string"): CursorPayload {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
    invalid();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    invalid();
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    invalid();
  }

  const { v, id } = parsed as Record<string, unknown>;
  const sortValueIsValid =
    sortKind === "number"
      ? typeof v === "number" && Number.isFinite(v)
      : sortKind === "iso-timestamp"
        ? typeof v === "string" && ISO_TIMESTAMP.test(v) && !Number.isNaN(Date.parse(v))
        : typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
  const idIsValid = typeof id === "number" && Number.isSafeInteger(id) && id > 0;
  if (!sortValueIsValid || !idIsValid) {
    invalid();
  }

  return { v: v as string | number, id };
}

/** Keyset cursor with a UUID tiebreaker `k`; `v` is an ISO-8601 instant with up to microsecond precision. */
export function encodeKeyCursor(payload: KeyCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeKeyCursor(cursor: string): KeyCursorPayload {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
    invalid();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    invalid();
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    invalid();
  }

  const { v, k } = parsed as Record<string, unknown>;
  const instantIsValid =
    typeof v === "string" && ISO_TIMESTAMP.test(v) && !Number.isNaN(Date.parse(v));
  const keyIsValid = typeof k === "string" && UUID.test(k);
  if (!instantIsValid || !keyIsValid) {
    invalid();
  }

  return { v, k };
}
