export type CursorSortKind = "iso-timestamp" | "string" | "number";

export interface CursorPayload {
  v: string | number;
  id: number;
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
