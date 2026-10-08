export type CursorSortKind = "iso-timestamp" | "string" | "number";

export interface CursorPayload {
  v: string | number;
  id: number;
}

/** Keyset cursor whose tiebreaker is a UUID rather than a numeric id (e.g. a refresh-token family). */
export interface KeyCursorPayload {
  v: string;
  k: string;
}

export interface PaginationMeta {
  nextCursor: string | null;
  hasMore: boolean;
  count: number;
}

export interface Page<T> {
  items: T[];
  meta: PaginationMeta;
}
