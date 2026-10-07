import { encodeCursor, encodeKeyCursor } from "./cursor";
import type { CursorPayload, KeyCursorPayload, Page } from "./types";

/** Repositories fetch `limit + 1` rows; this turns them into a page (CLAUDE.md -> API conventions). */
export function buildPage<T>(rows: T[], limit: number, cursorOf: (row: T) => CursorPayload): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return {
    items,
    meta: {
      nextCursor: hasMore && last !== undefined ? encodeCursor(cursorOf(last)) : null,
      hasMore,
      count: items.length,
    },
  };
}

/** Same as `buildPage`, for lists whose tiebreaker is a UUID (`encodeKeyCursor`). */
export function buildKeyPage<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => KeyCursorPayload,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return {
    items,
    meta: {
      nextCursor: hasMore && last !== undefined ? encodeKeyCursor(cursorOf(last)) : null,
      hasMore,
      count: items.length,
    },
  };
}
