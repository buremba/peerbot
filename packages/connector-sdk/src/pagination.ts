/**
 * Pagination generators for connectors.
 *
 * Async generators that capture the two hand-rolled pagination loops most
 * API connectors repeat: offset/limit paging and opaque-cursor paging. Each
 * yields one batch of items per page (including the final, possibly empty,
 * batch) so callers keep full control over transformation, emission, and
 * early exit (`break` stops further fetches).
 */

import { sleep } from './sleep.js';

export interface OffsetPage<T> {
  items: T[];
  /** Whether another page should be fetched (e.g. `!!data.next`). */
  hasMore: boolean;
}

export interface PaginateByOffsetOptions {
  /** Items per page; the offset advances by this amount after each page. */
  pageSize: number;
  /** Maximum number of pages to fetch. Default: unbounded. */
  maxPages?: number;
  /** Offset for the first page. Default 0. */
  startOffset?: number;
  /** Optional politeness delay before each page after the first. */
  delayMs?: number;
}

/** Yields item batches from an offset/limit-paginated endpoint. */
export async function* paginateByOffset<T>(
  fetchPage: (offset: number, pageSize: number) => Promise<OffsetPage<T>>,
  options: PaginateByOffsetOptions
): AsyncGenerator<T[], void, void> {
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
  let offset = options.startOffset ?? 0;

  for (let page = 0; page < maxPages; page++) {
    if (page > 0 && options.delayMs) await sleep(options.delayMs);
    const { items, hasMore } = await fetchPage(offset, options.pageSize);
    yield items;
    if (!hasMore) return;
    offset += options.pageSize;
  }
}

export interface CursorPage<T, C = string> {
  items: T[];
  /** Cursor for the next page; `null`/`undefined` stops pagination. */
  nextCursor: C | null | undefined;
}

export interface PaginateByCursorOptions<C = string> {
  /** Maximum number of pages to fetch. Default: unbounded. */
  maxPages?: number;
  /** Cursor passed to the first `fetchPage` call. Default `null`. */
  initialCursor?: C | null;
  /** Optional politeness delay before each page after the first. */
  delayMs?: number;
}

/** Yields item batches from a cursor/token-paginated endpoint. */
export async function* paginateByCursor<T, C = string>(
  fetchPage: (cursor: C | null) => Promise<CursorPage<T, C>>,
  options: PaginateByCursorOptions<C> = {}
): AsyncGenerator<T[], void, void> {
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
  let cursor: C | null = options.initialCursor ?? null;

  for (let page = 0; page < maxPages; page++) {
    if (page > 0 && options.delayMs) await sleep(options.delayMs);
    const { items, nextCursor } = await fetchPage(cursor);
    yield items;
    if (nextCursor === null || nextCursor === undefined) return;
    cursor = nextCursor;
  }
}
