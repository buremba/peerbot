import type { TObject } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { sdkLogger } from './logger.js';
import type {
  Checkpoint,
  Content,
  Env,
  FeedAuthSchema,
  FeedOptions,
  FeedSyncResult,
  IFeed,
  ParentFeedDefinition,
  ScoringConfig,
  SessionState,
} from './types.js';

export class RateLimitError extends Error {
  readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Base feed implementation with common functionality
 * All platform-specific feeds should extend this class
 */
export abstract class BaseFeed implements IFeed {
  abstract readonly type: string;
  abstract readonly displayName: string;
  abstract readonly apiType: 'api' | 'browser';
  abstract readonly feedMode: 'entity' | 'search';
  abstract readonly optionsSchema: TObject;
  abstract readonly defaultScoringConfig: ScoringConfig;
  abstract readonly defaultScoringFormula: string;

  readonly authSchema: FeedAuthSchema = { methods: [{ type: 'none' }] };

  abstract pull(
    options: FeedOptions,
    checkpoint: Checkpoint | null,
    env: Env,
    sessionState?: SessionState | null,
    updateCheckpointFn?: (checkpoint: Checkpoint) => Promise<void>
  ): Promise<FeedSyncResult>;

  abstract urlFromOptions(options: FeedOptions): string;

  abstract displayLabelFromOptions(options: FeedOptions): string;

  abstract validateOptions(options: FeedOptions): string | null;

  getParentFeedDefinitions(_options: FeedOptions): ParentFeedDefinition[] {
    return [];
  }

  /**
   * Validate options using TypeBox schema
   * Subclasses can call this for schema validation before adding custom business logic
   */
  protected validateWithSchema(options: FeedOptions): string | null {
    try {
      const errors = [...Value.Errors(this.optionsSchema, options)];
      if (errors.length > 0) {
        // Format first error for user-friendly message
        const firstError = errors[0];
        const field = firstError.path.replace(/^\//, '');
        return `Invalid option ${field ? `"${field}"` : ''}: ${firstError.message}`;
      }
      return null;
    } catch (error) {
      sdkLogger.error({ error }, '[BaseFeed] Schema validation error:');
      return 'Invalid feed options format';
    }
  }

  /**
   * Get rate limit information for this platform
   * Override this method in platform-specific feeds
   * Default is conservative: 10 requests per minute
   */
  getRateLimit() {
    return {
      requests_per_minute: 10,
      recommended_interval_ms: 6000, // 6 seconds
    };
  }

  /**
   * Helper to check if content is newer than checkpoint
   */
  protected isNewerThan(contentDate: Date, checkpoint: Checkpoint | null): boolean {
    if (!checkpoint || !checkpoint.last_timestamp) return true;
    return contentDate > checkpoint.last_timestamp;
  }

  /**
   * Calculate lookback date from options
   * @param options - Feed options with optional lookback_days
   * @param defaultDays - Default lookback period (default: 365)
   */
  protected getLookbackDate(options: FeedOptions, defaultDays: number = 365): Date {
    const lookbackDays = options.lookback_days || defaultDays;
    return new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  }

  /**
   * Sleep for specified milliseconds (for rate limiting)
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Check if feed is in incremental mode
   */
  protected isIncrementalMode(
    checkpoint: Checkpoint | null,
    paginationToken?: string | null
  ): boolean {
    return !!checkpoint?.last_timestamp && !paginationToken;
  }

  /**
   * Helper to deduplicate content by origin_id
   */
  protected deduplicate(contents: Content[], seenIds: Set<string>): Content[] {
    return contents.filter((c) => {
      if (!c.origin_id) return false;
      if (seenIds.has(c.origin_id)) return false;
      seenIds.add(c.origin_id);
      return true;
    });
  }

  /**
   * Handle HTTP errors with structured logging and platform-specific messages
   */
  protected handleHTTPError(status: number, context: string, platformName?: string): never {
    const platform = platformName || this.displayName;

    sdkLogger.error(
      {
        status,
        context,
        platform: this.type,
        timestamp: new Date().toISOString(),
      },
      `[${platform}Feed] HTTP ${status} error:`
    );

    const errorMessages: Record<number, string> = {
      400: `Bad request to ${platform}: ${context}. Check your feed options.`,
      401: `Authentication failed for ${platform}. Check your API credentials.`,
      403: `Access forbidden to ${platform} resource: ${context}. The resource may be private or require authentication.`,
      404: `Resource not found on ${platform}: ${context}. Verify the resource exists.`,
      422: `Invalid request to ${platform}: ${context}. Check your parameters.`,
      429: `${platform} rate limit exceeded. Please wait before retrying.`,
      500: `${platform} server error (${status}). This is temporary, please retry later.`,
      502: `${platform} bad gateway (${status}). This is temporary, please retry later.`,
      503: `${platform} service unavailable (${status}). This is temporary, please retry later.`,
    };

    const message = errorMessages[status] || `${platform} API error: ${status}`;
    if (status === 429) {
      throw new RateLimitError(message);
    }
    throw new Error(message);
  }
}
