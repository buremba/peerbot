/**
 * Browser Network Feed
 *
 * Helper for connectors that use browser network interception instead of DOM scraping.
 * Two-layer cascade:
 *   1. CDP — Playwright's connectOverCDP to user's real Chrome (default context).
 *      Works for network interception because we just open a tab and listen.
 *   2. Playwright — launch headless browser with stored cookies (fallback).
 *
 * Both paths share the same intercept → scroll → parse pipeline.
 * Fresh cookies are always captured and returned for persistence.
 */

import type { Browser, BrowserContext, Cookie, Page, Response } from 'playwright';
import { resolveCdpUrl } from './browser/cdp.js';
import { captureErrorArtifacts, launchBrowser } from './browser/launcher.js';
import { sdkLogger } from './logger.js';

export interface BrowserNetworkConfig {
  /** URL patterns to intercept (glob or regex). Matched against response URLs. */
  interceptPatterns: (string | RegExp)[];
  /** Cookie domains required for auth (e.g., ['x.com', '.x.com']) */
  authDomains: string[];
  /** Maximum number of scroll iterations for pagination (default: 10) */
  maxScrolls?: number;
  /** Delay between scrolls in ms (default: 2000) */
  scrollDelayMs?: number;
  /** Time to wait for API response after scroll in ms (default: 5000) */
  responseTimeoutMs?: number;
  /** Navigation timeout in ms (default: 15000) */
  navigationTimeoutMs?: number;
  /** Use stealth browser to evade bot detection (default: false) */
  stealth?: boolean;
}

export interface BrowserNetworkResult<TItem> {
  items: TItem[];
  cookies: Cookie[];
  apiCallCount: number;
  /** Which browser backend was used */
  backend: 'cdp' | 'playwright';
}

const DEFAULT_CONFIG: Required<
  Pick<
    BrowserNetworkConfig,
    'maxScrolls' | 'scrollDelayMs' | 'responseTimeoutMs' | 'navigationTimeoutMs'
  >
> = {
  maxScrolls: 10,
  scrollDelayMs: 2000,
  responseTimeoutMs: 5000,
  navigationTimeoutMs: 15000,
};

// ---------------------------------------------------------------------------
// Browser acquisition for network interception
// Uses Playwright's connectOverCDP (needs response events) with fallback.
// ---------------------------------------------------------------------------

interface NetworkBrowser {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  backend: 'cdp' | 'playwright';
  ownsBrowser: boolean;
  screenshotDir: string;
}

async function acquireForNetworkSync(
  cdpUrl: string | 'auto' | null | undefined,
  cookies: Cookie[],
  stealth: boolean
): Promise<NetworkBrowser> {
  // --- Layer 1: CDP via Playwright connectOverCDP ---
  if (cdpUrl !== null && cdpUrl !== undefined) {
    try {
      const wsUrl = await resolveCdpUrl(cdpUrl === 'auto' ? 'auto' : cdpUrl, {
        loggerLabel: 'BrowserNetwork',
        preferRealBrowser: true,
      });

      const playwrightModule = 'playwright';
      const { chromium } = await import(/* @vite-ignore */ playwrightModule);
      const browser: Browser = await chromium.connectOverCDP(wsUrl);

      // Use the default context (user's session) — don't create a new context
      // which crashes on browsers with many tabs
      const context = browser.contexts()[0] as BrowserContext;
      if (!context) throw new Error('Chrome has no browser context');

      const page = await context.newPage();

      sdkLogger.info({ wsUrl }, '[BrowserNetwork] Connected via CDP');

      return {
        browser,
        context,
        page,
        backend: 'cdp',
        ownsBrowser: false,
        screenshotDir: '/tmp/feed-screenshots',
      };
    } catch (err: any) {
      sdkLogger.info(
        { error: err.message },
        '[BrowserNetwork] CDP not available, falling back to Playwright'
      );
    }
  }

  // --- Layer 2: Playwright with stored cookies ---
  const { browser, screenshotDir } = await launchBrowser({} as never, { stealth });
  const context = (await (browser as Browser).newContext()) as BrowserContext;
  if (cookies.length > 0) {
    await context.addCookies(cookies);
    sdkLogger.info({ count: cookies.length }, '[BrowserNetwork] Loaded persisted cookies');
  }
  const page = await context.newPage();

  return {
    browser: browser as Browser,
    context,
    page,
    backend: 'playwright',
    ownsBrowser: true,
    screenshotDir,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function browserNetworkSync<TItem>(opts: {
  config: BrowserNetworkConfig;
  url: string;
  /** Stored cookies for Playwright fallback. Can be empty if CDP is expected. */
  cookies: Cookie[];
  parseResponse: (url: string, json: unknown) => TItem[];
  triggerNextPage?: (page: Page) => Promise<void>;
  checkAuth?: (page: Page) => Promise<boolean>;
  /**
   * CDP endpoint URL, 'auto' to auto-discover, or null/undefined to skip CDP.
   * When set, CDP is tried first; if unavailable, falls back to Playwright + cookies.
   */
  cdpUrl?: string | 'auto' | null;
}): Promise<BrowserNetworkResult<TItem>> {
  const cfg = { ...DEFAULT_CONFIG, ...opts.config };
  const items: TItem[] = [];
  let apiCallCount = 0;

  // Pre-compile string glob patterns into RegExp for hot-path matching
  const matchers: RegExp[] = cfg.interceptPatterns.map((p) =>
    typeof p === 'string' ? compileGlob(p) : p
  );
  const matchesUrl = (url: string) => matchers.some((re) => re.test(url));

  const acquired = await acquireForNetworkSync(
    opts.cdpUrl ?? null,
    opts.cookies,
    cfg.stealth ?? false
  );

  const { context, page, backend, ownsBrowser, browser, screenshotDir } = acquired;

  try {
    // Accumulates promises from async response handlers between drain points
    const responsePromises: Promise<void>[] = [];

    page.on('response', (response: Response) => {
      if (!matchesUrl(response.url())) return;
      const p = response
        .json()
        .then((json) => {
          apiCallCount++;
          const parsed = opts.parseResponse(response.url(), json);
          items.push(...parsed);
          sdkLogger.info(
            { apiCall: apiCallCount, itemsInBatch: parsed.length, totalItems: items.length },
            '[BrowserNetwork] Intercepted API response'
          );
        })
        .catch(() => {});
      responsePromises.push(p);
    });

    sdkLogger.info({ url: opts.url, backend }, '[BrowserNetwork] Navigating');
    await page.goto(opts.url, {
      waitUntil: 'domcontentloaded',
      timeout: cfg.navigationTimeoutMs,
    });

    await page.waitForTimeout(cfg.responseTimeoutMs);
    await drainPromises(responsePromises);

    if (opts.checkAuth) {
      const authed = await opts.checkAuth(page);
      if (!authed) {
        const msg =
          backend === 'cdp'
            ? 'Authentication check failed via CDP — you may not be logged in to this site in Chrome'
            : 'Authentication failed — cookies may be expired. Re-run: lobu memory browser-auth';
        throw new Error(msg);
      }
    }

    const triggerNext =
      opts.triggerNextPage ??
      (async (p: Page) => {
        await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      });

    let prevCount = items.length;
    for (let scroll = 0; scroll < cfg.maxScrolls; scroll++) {
      await triggerNext(page);

      try {
        await page.waitForResponse((resp: Response) => matchesUrl(resp.url()), {
          timeout: cfg.responseTimeoutMs,
        });
      } catch {
        sdkLogger.info({ scroll: scroll + 1 }, '[BrowserNetwork] No new API response, stopping');
        break;
      }

      await page.waitForTimeout(cfg.scrollDelayMs);
      await drainPromises(responsePromises);

      if (items.length === prevCount) {
        sdkLogger.info({ scroll: scroll + 1 }, '[BrowserNetwork] No new items, stopping');
        break;
      }

      sdkLogger.info(
        { scroll: scroll + 1, newItems: items.length - prevCount, total: items.length },
        '[BrowserNetwork] Scroll pagination'
      );
      prevCount = items.length;
    }

    // Always capture cookies — regardless of backend, these get persisted
    const cookies = await context.cookies(
      cfg.authDomains.map((d) => (d.startsWith('http') ? d : `https://${d}`))
    );

    return { items, cookies, apiCallCount, backend };
  } catch (error: any) {
    if (page) {
      await captureErrorArtifacts(page, error, 'browser-network', screenshotDir);
    }
    throw error;
  } finally {
    // CDP: only close our tab, not the user's context or browser.
    // Playwright: close context and browser (we own them).
    if (ownsBrowser) {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    } else {
      await page.close().catch(() => {});
    }
  }
}

/** Snapshot-then-clear to avoid losing promises pushed between Promise.all and clear. */
async function drainPromises(arr: Promise<void>[]): Promise<void> {
  const batch = [...arr];
  arr.length = 0;
  await Promise.all(batch);
}

function compileGlob(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*');
  return new RegExp(escaped);
}
