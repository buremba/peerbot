/**
 * Paginated Feed Base Class
 *
 * Provides a reusable pagination pattern for feeds that fetch data in pages.
 * Uses the template method pattern - subclasses implement specific methods while
 * the base class handles the pagination loop, rate limiting, and checkpoint management.
 */

import { BaseFeed, RateLimitError } from './base.js';
import { sdkLogger } from './logger.js';
import type { Checkpoint, Content, Env, FeedOptions } from './types.js';

/**
 * Configuration for pagination behavior
 */
export interface PaginationConfig {
  /** Maximum pages to fetch (safety limit). Default: 50 */
  maxPages: number;
  /** Expected items per page (for partial page detection). Default: 100 */
  pageSize: number;
  /** Milliseconds to wait between page requests. Default: 1000 */
  rateLimitMs: number;
  /** Whether to update checkpoint after each page (for resume). Default: false */
  incrementalCheckpoint: boolean;
}

/**
 * Result from fetching a single page
 */
export interface PageFetchResult<TItem> {
  /** Items from this page */
  items: TItem[];
  /** Token/cursor for next page (null = no more pages) */
  nextToken: string | null;
  /** Optional: raw item count before any filtering (for logging) */
  rawCount?: number;
}

/**
 * Extended checkpoint interface with pagination token
 */
export interface PaginatedCheckpoint extends Checkpoint {
  /** Pagination token for resuming sync */
  pagination_token?: string | null;
  /** Whether initial sync completed (used to choose checkpoint boundary) */
  initial_complete?: boolean;
}

/**
 * Result from the paginate() method
 */
export interface PaginateResult<TCheckpoint extends Checkpoint> {
  contents: Content[];
  checkpoint: TCheckpoint;
  parentMap?: Map<string, string>;
  nextSyncRecommendedAt?: Date;
}

/**
 * Base class for feeds with cursor/page-based pagination
 */
export abstract class PaginatedFeed<
  TItem,
  TCheckpoint extends PaginatedCheckpoint = PaginatedCheckpoint,
> extends BaseFeed {
  /**
   * Default pagination configuration
   */
  protected getPaginationConfig(): PaginationConfig {
    return {
      maxPages: 50,
      pageSize: 100,
      rateLimitMs: 1000,
      incrementalCheckpoint: false,
    };
  }

  /**
   * ABSTRACT: Fetch a single page of items from the platform
   */
  protected abstract fetchPage(
    cursor: string | null,
    options: FeedOptions,
    env: Env
  ): Promise<PageFetchResult<TItem>>;

  /**
   * ABSTRACT: Transform a platform item to Content format
   */
  protected abstract transformItem(item: TItem, options: FeedOptions): Content;

  /**
   * ABSTRACT: Extract published date from platform item
   */
  protected abstract getItemDate(item: TItem): Date;

  /**
   * OPTIONAL: Filter items before transformation
   */
  protected filterItem(_item: TItem, _options: FeedOptions): boolean {
    return true;
  }

  /**
   * OPTIONAL: Extract parent ID for hierarchical content
   */
  protected getParentId(_item: TItem): string | null {
    return null;
  }

  /**
   * OPTIONAL: Extract pagination token from checkpoint
   */
  protected getPaginationToken(checkpoint: TCheckpoint | null): string | null {
    return checkpoint?.pagination_token ?? null;
  }

  /**
   * OPTIONAL: Create checkpoint with feed-specific fields
   */
  protected createCheckpoint(
    existing: TCheckpoint | null,
    latestContent: Content | null,
    nextToken: string | null,
    itemsProcessed: number
  ): TCheckpoint {
    return {
      updated_at: new Date(),
      last_timestamp: latestContent?.occurred_at ?? existing?.last_timestamp,
      pagination_token: nextToken,
      total_items_processed: (existing?.total_items_processed || 0) + itemsProcessed,
      initial_complete: existing?.initial_complete ?? false,
    } as TCheckpoint;
  }

  /**
   * Main pagination loop - handles both initial and incremental syncs
   */
  protected async paginate(
    options: FeedOptions,
    checkpoint: TCheckpoint | null,
    env: Env,
    updateCheckpointFn?: (checkpoint: Checkpoint) => Promise<void>
  ): Promise<PaginateResult<TCheckpoint>> {
    const config = this.getPaginationConfig();
    const existingToken = this.getPaginationToken(checkpoint);
    const parentMap = new Map<string, string>();
    const initialComplete =
      checkpoint?.initial_complete ?? (!!checkpoint?.last_timestamp && !existingToken);
    const isIncremental = initialComplete && !existingToken;
    const lookbackDate = this.getLookbackDate(options);
    const checkpointTimestamp = checkpoint?.last_timestamp ?? null;
    const checkpointDate = checkpointTimestamp
      ? checkpointTimestamp instanceof Date
        ? checkpointTimestamp
        : new Date(checkpointTimestamp)
      : null;
    const boundaryDate = initialComplete && checkpointDate ? checkpointDate : lookbackDate;

    const allContents: Content[] = [];
    let cursor = isIncremental ? null : existingToken;
    let pageCount = 0;
    let stopReason:
      | 'empty_page'
      | 'boundary'
      | 'partial_page'
      | 'no_next_token'
      | 'max_pages'
      | 'rate_limited'
      | null = null;
    let rateLimitRetryMs: number | undefined;
    const modeLabel = isIncremental ? 'incremental' : cursor ? 'resumed' : 'initial';

    sdkLogger.info(`[${this.type}] Starting ${modeLabel} sync (max ${config.maxPages} pages)`);

    while (pageCount < config.maxPages) {
      if (pageCount > 0) {
        await this.sleep(config.rateLimitMs);
      }

      let result: PageFetchResult<TItem>;
      try {
        result = await this.fetchPage(cursor, options, env);
      } catch (error) {
        if (error instanceof RateLimitError) {
          sdkLogger.warn(
            { error: error.message },
            `[${this.type}] Rate limit hit after ${pageCount} pages, pausing`
          );
          stopReason = 'rate_limited';
          rateLimitRetryMs = error.retryAfterMs;
          break;
        }
        throw error;
      }
      const rawCount = result.rawCount ?? result.items.length;

      if (result.items.length === 0) {
        sdkLogger.info(`[${this.type}] Empty page at ${pageCount + 1}, stopping`);
        stopReason = 'empty_page';
        break;
      }

      const pageContents: Content[] = [];
      for (const item of result.items) {
        if (!this.filterItem(item, options)) continue;

        const content = this.transformItem(item, options);
        pageContents.push(content);

        const parentId = this.getParentId(item);
        if (parentId) {
          parentMap.set(content.origin_id, parentId);
          if (!content.origin_parent_id) {
            content.origin_parent_id = parentId;
          }
        }
      }

      const boundaryContents = pageContents.filter((c) => c.occurred_at >= boundaryDate);
      allContents.push(...boundaryContents);

      pageCount++;

      sdkLogger.info(
        `[${this.type}] Page ${pageCount}: raw=${rawCount}, ` +
          `filtered=${pageContents.length}, recent=${boundaryContents.length}, ` +
          `nextToken=${result.nextToken ? 'yes' : 'no'}`
      );

      if (config.incrementalCheckpoint && updateCheckpointFn && allContents.length > 0) {
        const incrementalCP = this.createCheckpoint(
          checkpoint,
          allContents[0],
          result.nextToken,
          boundaryContents.length
        );
        await updateCheckpointFn(incrementalCP);
        sdkLogger.debug(`[${this.type}] Saved incremental checkpoint after page ${pageCount}`);
      }

      if (boundaryContents.length === 0 && pageContents.length > 0) {
        sdkLogger.info(`[${this.type}] Reached boundary after ${pageCount} pages`);
        stopReason = 'boundary';
        break;
      }

      if (result.items.length < config.pageSize) {
        sdkLogger.info(
          `[${this.type}] Partial page (${result.items.length}/${config.pageSize}), end reached`
        );
        stopReason = 'partial_page';
        break;
      }

      if (!result.nextToken) {
        sdkLogger.info(`[${this.type}] No next token after page ${pageCount}, end reached`);
        stopReason = 'no_next_token';
        break;
      }

      cursor = result.nextToken;
    }

    if (!stopReason && pageCount >= config.maxPages) {
      stopReason = 'max_pages';
    }

    if (stopReason === 'max_pages') {
      sdkLogger.warn(`[${this.type}] Hit max page limit (${config.maxPages})`);
    }

    sdkLogger.info(
      `[${this.type}] Pagination complete: ${allContents.length} items from ${pageCount} pages`
    );

    const resumeToken = stopReason === 'max_pages' || stopReason === 'rate_limited' ? cursor : null;
    const shouldMarkComplete =
      initialComplete ||
      (!initialComplete && stopReason !== 'max_pages' && stopReason !== 'rate_limited');
    const nextSyncRecommendedAt =
      stopReason === 'rate_limited'
        ? new Date(Date.now() + (rateLimitRetryMs ?? config.rateLimitMs))
        : undefined;

    const finalCheckpoint = this.createCheckpoint(
      checkpoint,
      allContents[0] || null,
      resumeToken,
      allContents.length
    );
    finalCheckpoint.initial_complete = shouldMarkComplete;

    return {
      contents: allContents,
      checkpoint: finalCheckpoint,
      parentMap: parentMap.size > 0 ? parentMap : undefined,
      nextSyncRecommendedAt,
    };
  }
}
