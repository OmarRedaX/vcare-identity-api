import { ValidationFailed } from "../../error/errors";
import type { CursorPayload } from "./types";

const MAX_CURSOR_LENGTH = 512;

function invalid(): never {
  throw ValidationFailed.withDetails([{ field: "cursor", issue: "is invalid" }]);
}

/** Keyset cursor: the sort value plus the id, so ties are stable (CLAUDE.md -> API conventions). */
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorPayload {
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
  const sortValueIsValid = typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
  const idIsValid = typeof id === "number" && Number.isSafeInteger(id) && id > 0;
  if (!sortValueIsValid || !idIsValid) {
    invalid();
  }

  return { v, id };
}
