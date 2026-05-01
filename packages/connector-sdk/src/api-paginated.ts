/**
 * API Paginated Feed Base Class
 *
 * Extends PaginatedFeed for HTTP/REST API-based feeds.
 * Provides HTTP client setup and common API patterns.
 */

import type { KyInstance } from 'ky';
import { HTTPError } from 'ky';
import { RateLimitError } from './base.js';
import { createAuthenticatedClient, createHttpClient, httpClient } from './http.js';
import { sdkLogger } from './logger.js';
import type { PageFetchResult, PaginatedCheckpoint } from './paginated.js';
import { PaginatedFeed } from './paginated.js';
import { withHttpRetry } from './retry.js';
import type { Env, FeedOptions, SessionState } from './types.js';

/**
 * API session state for OAuth/token-based feeds
 */
export interface ApiSessionState extends SessionState {
  /** OAuth/API access token */
  access_token?: string;
  /** OAuth refresh token (for token refresh flows) */
  refresh_token?: string;
  /** Token type (e.g., 'Bearer') */
  token_type?: string;
  /** Token expiration time (ISO string) */
  expires_at?: string;
  /** Additional headers to include in requests */
  headers?: Record<string, string>;
  /** API key (alternative to OAuth tokens) */
  api_key?: string;
}

/**
 * Base class for API-based feeds with HTTP pagination
 */
export abstract class ApiPaginatedFeed<
  TItem,
  TResponse = unknown,
  TCheckpoint extends PaginatedCheckpoint = PaginatedCheckpoint,
> extends PaginatedFeed<TItem, TCheckpoint> {
  readonly apiType = 'api' as const;

  /**
   * Session state for this sync session
   */
  protected _sessionState: ApiSessionState | null = null;

  /**
   * Set session state for this sync session
   */
  protected setSessionState(sessionState: SessionState | null | undefined): void {
    this._sessionState = (sessionState as ApiSessionState) || null;
    if (this._sessionState) {
      sdkLogger.debug(
        { hasToken: !!this._sessionState.access_token, hasApiKey: !!this._sessionState.api_key },
        `[${this.type}] Session state set`
      );
    }
  }

  /**
   * Get current session state
   */
  protected getSessionState(): ApiSessionState | null {
    return this._sessionState;
  }

  /**
   * ABSTRACT: Build URL for fetching a specific page
   */
  protected abstract buildPageUrl(cursor: string | null, options: FeedOptions): string;

  /**
   * ABSTRACT: Parse API response into items and next token
   */
  protected abstract parseResponse(
    response: TResponse,
    options: FeedOptions
  ): PageFetchResult<TItem>;

  /**
   * Get configured HTTP client for this feed
   */
  protected getHttpClient(_env: Env): KyInstance {
    return httpClient;
  }

  /**
   * Create HTTP client with Bearer token authentication
   */
  protected createBearerClient(
    token: string,
    additionalHeaders?: Record<string, string>
  ): KyInstance {
    return createAuthenticatedClient(`Bearer ${token}`, additionalHeaders);
  }

  /**
   * Create HTTP client with custom headers
   */
  protected createClientWithHeaders(headers: Record<string, string>): KyInstance {
    return createHttpClient({ headers });
  }

  /**
   * Create HTTP client from session state
   */
  protected createClientFromSessionState(additionalHeaders?: Record<string, string>): KyInstance {
    if (!this._sessionState) {
      return additionalHeaders ? createHttpClient({ headers: additionalHeaders }) : httpClient;
    }

    const headers: Record<string, string> = {
      ...this._sessionState.headers,
      ...additionalHeaders,
    };

    if (this._sessionState.access_token) {
      const tokenType = this._sessionState.token_type || 'Bearer';
      return createAuthenticatedClient(`${tokenType} ${this._sessionState.access_token}`, headers);
    }

    if (this._sessionState.api_key) {
      return createAuthenticatedClient(this._sessionState.api_key, headers);
    }

    return Object.keys(headers).length > 0 ? createHttpClient({ headers }) : httpClient;
  }

  /**
   * Handle HTTP errors with platform-specific messages
   */
  protected handleHttpError(error: HTTPError, url: string): never {
    this.handleHTTPError(error.response.status, url);
  }

  /**
   * Default fetchPage implementation using HTTP client with retry
   */
  protected async fetchPage(
    cursor: string | null,
    options: FeedOptions,
    env: Env
  ): Promise<PageFetchResult<TItem>> {
    const client = this.getHttpClient(env);
    const url = this.buildPageUrl(cursor, options);

    try {
      const response = await withHttpRetry(async () => client.get(url).json<TResponse>(), {
        operation: `${this.type} API fetch`,
        context: { url, cursor },
      });

      return this.parseResponse(response, options);
    } catch (error) {
      if (error instanceof HTTPError) {
        if (error.response.status === 429) {
          const retryAfter = error.response.headers.get('retry-after');
          let retryAfterMs: number | undefined;
          if (retryAfter) {
            const numericRetry = Number(retryAfter);
            if (!Number.isNaN(numericRetry)) {
              retryAfterMs = numericRetry * 1000;
            } else {
              const retryDate = Date.parse(retryAfter);
              if (!Number.isNaN(retryDate)) {
                retryAfterMs = retryDate - Date.now();
              }
            }
          }
          throw new RateLimitError(
            `${this.displayName} rate limit exceeded. Please wait before retrying.`,
            retryAfterMs && retryAfterMs > 0 ? retryAfterMs : undefined
          );
        }
        this.handleHttpError(error, url);
      }
      sdkLogger.error({ error, url }, `[${this.type}] API fetch failed`);
      throw error;
    }
  }
}
