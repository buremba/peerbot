/// <reference lib="dom" />
/**
 * Browser Paginated Feed Base Class
 *
 * Extends PaginatedFeed for browser-based feeds (Playwright).
 */

import type { Browser, Cookie, Page } from 'playwright';
import { captureErrorArtifacts, launchBrowser } from './browser/launcher.js';
import { sdkLogger } from './logger.js';
import type { PageFetchResult, PaginatedCheckpoint, PaginationConfig } from './paginated.js';
import { PaginatedFeed } from './paginated.js';
import type { Checkpoint, Env, FeedOptions, FeedSyncResult, SessionState } from './types.js';

/**
 * Browser session state - Playwright-compatible format
 */
export interface BrowserSessionState extends SessionState {
  /** Playwright-compatible cookies */
  cookies?: Cookie[];
  /** localStorage key-value pairs (applied via page.evaluate) */
  localStorage?: Record<string, string>;
  /** Extra HTTP headers to set */
  headers?: Record<string, string>;
}

/**
 * Cookie consent configuration for handling cookie banners
 */
export interface CookieConsentConfig {
  /** CSS selectors to detect cookie consent banner */
  bannerSelectors: string[];
  /** CSS selectors for accept button */
  acceptSelectors: string[];
  /** Timeout in ms to wait for banner (default: 2000) */
  timeout?: number;
}

/**
 * CAPTCHA detection configuration
 */
export interface CaptchaConfig {
  /** Enable CAPTCHA detection (default: false) */
  enabled: boolean;
  /** CSS selectors that indicate CAPTCHA presence */
  selectors?: string[];
  /** Text patterns in page content that indicate CAPTCHA */
  textPatterns?: string[];
}

/**
 * Browser configuration for the feed
 */
export interface BrowserFeedConfig {
  /** Enable stealth mode to avoid bot detection (default: true) */
  stealth: boolean;
  /** Custom viewport dimensions (default: browser default) */
  viewport?: { width: number; height: number };
  /** Custom user agent (default: browser default) */
  userAgent?: string;
  /** Navigation waitUntil option */
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle';
  /** Navigation timeout in ms (default: 60000) */
  navigationTimeout: number;
  /** Cookie consent handling configuration */
  cookieConsent?: CookieConsentConfig;
  /** CAPTCHA detection configuration */
  captcha?: CaptchaConfig;
}

/**
 * Browser-specific pagination configuration
 */
export interface BrowserPaginationConfig extends PaginationConfig {
  /** Number of pages to fetch per sync run (default: 1, G2 uses 5) */
  pagesPerRun: number;
  /** Delay between page navigations in ms (default: 2000) */
  pageDelayMs: number;
}

/**
 * Base class for browser-based feeds with pagination
 */
export abstract class BrowserPaginatedFeed<
  TItem,
  TCheckpoint extends PaginatedCheckpoint = PaginatedCheckpoint,
> extends PaginatedFeed<TItem, TCheckpoint> {
  readonly apiType = 'browser' as const;

  private _browser: Browser | null = null;
  private _page: Page | null = null;
  private _screenshotDir: string = '';
  private _isFirstPage: boolean = true;
  private _currentPageNumber: number = 0;

  /**
   * ABSTRACT: Get browser configuration for this feed
   */
  protected abstract getBrowserConfig(): BrowserFeedConfig;

  /**
   * ABSTRACT: Get base URL from feed options
   */
  protected abstract getBaseUrl(options: FeedOptions): string;

  /**
   * ABSTRACT: Build URL for a specific page number
   */
  protected abstract buildPageUrl(baseUrl: string, pageNumber: number): string;

  /**
   * ABSTRACT: Wait for page content to be ready after navigation
   */
  protected abstract waitForContent(page: Page): Promise<void>;

  /**
   * ABSTRACT: Extract items from the current page DOM
   */
  protected abstract extractItems(page: Page): Promise<TItem[]>;

  /**
   * Browser-specific pagination configuration
   */
  protected getBrowserPaginationConfig(): BrowserPaginationConfig {
    return {
      ...this.getPaginationConfig(),
      pagesPerRun: 1,
      pageDelayMs: 2000,
    };
  }

  /**
   * Override pull() to manage browser lifecycle
   */
  async pull(
    options: FeedOptions,
    checkpoint: TCheckpoint | null,
    env: Env,
    sessionState?: SessionState | null,
    updateCheckpointFn?: (checkpoint: Checkpoint) => Promise<void>
  ): Promise<FeedSyncResult> {
    const config = this.getBrowserConfig();
    const browserSessionState = sessionState as BrowserSessionState | null | undefined;

    const { browser, screenshotDir } = await launchBrowser(env, { stealth: config.stealth });
    this._browser = browser as Browser;
    this._page = (await browser.newPage()) as Page;
    this._screenshotDir = screenshotDir;
    this._isFirstPage = true;
    this._currentPageNumber = 0;

    if (config.viewport) {
      await this._page.setViewportSize(config.viewport);
    }
    if (config.userAgent) {
      await this._page.setExtraHTTPHeaders({
        'User-Agent': config.userAgent,
      });
    }

    if (browserSessionState) {
      await this.applySessionState(this._page, browserSessionState);
    }

    try {
      const result = await this.paginate(options, checkpoint, env, updateCheckpointFn);

      let parentMapRecord: Record<string, string> | undefined;
      if (result.parentMap && result.parentMap.size > 0) {
        parentMapRecord = Object.fromEntries(result.parentMap);
      }

      const capturedSessionState = await this.captureSessionState(this._page);

      return {
        contents: result.contents,
        checkpoint: result.checkpoint,
        metadata: {
          items_found: result.contents.length,
          items_skipped: 0,
          parent_map: parentMapRecord,
          next_sync_recommended_at: result.nextSyncRecommendedAt,
        },
        auth_update: capturedSessionState,
      };
    } catch (error: any) {
      if (this._page) {
        await captureErrorArtifacts(this._page, error, this.type, this._screenshotDir);
      }
      throw error;
    } finally {
      if (this._browser) {
        await this._browser.close();
        this._browser = null;
        this._page = null;
      }
    }
  }

  /**
   * Apply session state to browser page before navigation
   */
  protected async applySessionState(page: Page, sessionState: BrowserSessionState): Promise<void> {
    if (sessionState.cookies && sessionState.cookies.length > 0) {
      try {
        await page.context().addCookies(sessionState.cookies);
        sdkLogger.info(
          { cookieCount: sessionState.cookies.length },
          `[${this.type}] Applied session cookies`
        );
      } catch (error) {
        sdkLogger.warn({ error }, `[${this.type}] Failed to apply session cookies`);
      }
    }

    if (sessionState.headers && Object.keys(sessionState.headers).length > 0) {
      try {
        await page.setExtraHTTPHeaders(sessionState.headers);
        sdkLogger.info(
          { headerCount: Object.keys(sessionState.headers).length },
          `[${this.type}] Applied session headers`
        );
      } catch (error) {
        sdkLogger.warn({ error }, `[${this.type}] Failed to apply session headers`);
      }
    }

    if (sessionState.localStorage && Object.keys(sessionState.localStorage).length > 0) {
      sdkLogger.debug(
        { keyCount: Object.keys(sessionState.localStorage).length },
        `[${this.type}] localStorage will be applied after first navigation`
      );
    }
  }

  /**
   * Capture browser session state after sync for persistence
   */
  protected async captureSessionState(page: Page): Promise<BrowserSessionState> {
    const sessionState: BrowserSessionState = {};

    try {
      const cookies = await page.context().cookies();
      if (cookies.length > 0) {
        sessionState.cookies = cookies;
        sdkLogger.debug({ cookieCount: cookies.length }, `[${this.type}] Captured session cookies`);
      }
    } catch (error) {
      sdkLogger.warn({ error }, `[${this.type}] Failed to capture session cookies`);
    }

    try {
      const localStorage = await page.evaluate(() => {
        const storage: Record<string, string> = {};
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          if (key) {
            storage[key] = window.localStorage.getItem(key) || '';
          }
        }
        return storage;
      });
      if (Object.keys(localStorage).length > 0) {
        sessionState.localStorage = localStorage;
        sdkLogger.debug(
          { keyCount: Object.keys(localStorage).length },
          `[${this.type}] Captured localStorage`
        );
      }
    } catch (error) {
      sdkLogger.debug({ error }, `[${this.type}] Could not capture localStorage (may be expected)`);
    }

    return sessionState;
  }

  /**
   * fetchPage() implementation for browser-based pagination
   */
  protected async fetchPage(
    cursor: string | null,
    options: FeedOptions,
    _env: Env
  ): Promise<PageFetchResult<TItem>> {
    const pageNumber = cursor ? parseInt(cursor, 10) : 1;
    this._currentPageNumber = pageNumber;

    const baseUrl = this.getBaseUrl(options);
    const pageUrl = this.buildPageUrl(baseUrl, pageNumber);
    const config = this.getBrowserConfig();
    const paginationConfig = this.getBrowserPaginationConfig();
    const page = this._page!;

    sdkLogger.info(
      { pageUrl, pageNumber, maxPages: paginationConfig.pagesPerRun },
      `[${this.type}] Fetching page`
    );

    await page.goto(pageUrl, {
      waitUntil: config.waitUntil,
      timeout: config.navigationTimeout,
    });

    if (this._isFirstPage && config.cookieConsent) {
      await this.handleCookieConsent(page, config.cookieConsent);
      this._isFirstPage = false;
    }

    if (config.captcha?.enabled) {
      await this.checkForCaptcha(page, config.captcha);
    }

    await this.waitForContent(page);

    const items = await this.extractItems(page);

    sdkLogger.info(
      { itemCount: items.length, pageNumber },
      `[${this.type}] Extracted items from page`
    );

    const hasNext =
      items.length > 0 &&
      items.length >= paginationConfig.pageSize &&
      pageNumber < paginationConfig.pagesPerRun;

    if (hasNext && paginationConfig.pageDelayMs > 0) {
      await this.sleep(paginationConfig.pageDelayMs);
    }

    return {
      items,
      nextToken: hasNext ? String(pageNumber + 1) : null,
      rawCount: items.length,
    };
  }

  /**
   * Handle cookie consent banner
   */
  protected async handleCookieConsent(page: Page, config: CookieConsentConfig): Promise<void> {
    try {
      const timeout = config.timeout ?? 2000;

      for (const selector of config.bannerSelectors) {
        try {
          const banner = await page.$(selector);
          if (banner) {
            for (const acceptSelector of config.acceptSelectors) {
              try {
                const acceptButton = await page.$(acceptSelector);
                if (acceptButton) {
                  await acceptButton.click();
                  await this.sleep(1000);
                  sdkLogger.debug(`[${this.type}] Cookie consent accepted`);
                  return;
                }
              } catch (_e) {
                // Try next accept selector
              }
            }
          }
        } catch (_e) {
          // Try next banner selector
        }
      }

      const bannerSelector = config.bannerSelectors.join(', ');
      try {
        await page.waitForSelector(bannerSelector, { timeout });
        const acceptSelector = config.acceptSelectors.join(', ');
        await page.click(acceptSelector);
        await this.sleep(1000);
        sdkLogger.debug(`[${this.type}] Cookie consent accepted (waited)`);
      } catch (_e) {
        // No cookie banner or already dismissed
      }
    } catch (_e) {
      sdkLogger.debug(`[${this.type}] No cookie banner found or already handled`);
    }
  }

  /**
   * Check for CAPTCHA and throw if detected
   */
  protected async checkForCaptcha(page: Page, config: CaptchaConfig): Promise<void> {
    const hasCaptcha = await page.evaluate(
      (cfg: { selectors?: string[]; textPatterns?: string[] }) => {
        if (cfg.selectors) {
          for (const selector of cfg.selectors) {
            if (document.querySelector(selector)) return true;
          }
        }

        if (cfg.textPatterns) {
          const bodyText = document.body.textContent || '';
          for (const pattern of cfg.textPatterns) {
            if (bodyText.includes(pattern)) return true;
          }
        }

        return false;
      },
      { selectors: config.selectors, textPatterns: config.textPatterns }
    );

    if (hasCaptcha) {
      throw new Error(`CAPTCHA detected - ${this.displayName} blocking access`);
    }
  }

  /**
   * Get current page number
   */
  protected getCurrentPageNumber(): number {
    return this._currentPageNumber;
  }

  /**
   * Get the Playwright page instance
   */
  protected getPage(): Page | null {
    return this._page;
  }
}
