/**
 * Browser Acquisition
 *
 * Single entry point for all browser-based connectors. Implements a two-layer
 * cascade:
 *
 *   1. CDP — connect to user's real Chrome via raw CDP protocol.
 *      Uses CdpPage for DOM scraping (avoids Playwright's connectOverCDP crash
 *      on browsers with many tabs). For network interception, callers use
 *      Playwright's connectOverCDP on the resolved wsUrl directly.
 *
 *   2. Playwright — launch headless browser, inject stored cookies.
 *      Cookies may come from a previous CDP session (freshest) or CLI capture.
 *
 * Both paths share the same caller API. Fresh cookies are always captured
 * from the resulting context so the caller can persist them for future fallback.
 */

import type { Browser, BrowserContext, Cookie, Page } from 'playwright';
import { sdkLogger } from '../logger.js';
import { resolveCdpUrl } from './cdp.js';
import { CdpPage } from './cdp-page.js';
import { launchBrowser } from './launcher.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AcquireBrowserOptions {
  /** CDP endpoint URL, 'auto' to auto-discover, or null to skip CDP entirely. */
  cdpUrl?: string | 'auto' | null;
  /** Stored cookies for Playwright fallback. May be empty. */
  cookies: Cookie[];
  /** Cookie domains to capture after sync (e.g., ['x.com', '.x.com']). */
  authDomains: string[];
  /** Use stealth/anti-detection mode for Playwright launch (default: false). */
  stealth?: boolean;
}

export interface AcquiredBrowser {
  /** Playwright Browser (null when using raw CDP). */
  browser: Browser | null;
  /** Playwright BrowserContext (null when using raw CDP). */
  context: BrowserContext | null;
  /** Playwright Page (null when using raw CDP — use cdpPage instead). */
  page: Page | null;
  /** Raw CDP page handle (null when using Playwright). */
  cdpPage: CdpPage | null;
  /** Resolved CDP WebSocket URL (available when backend is 'cdp'). */
  cdpWsUrl: string | null;
  /** Which backend was used. */
  backend: 'cdp' | 'playwright';
  /** If false, don't close the browser on cleanup (CDP — it's the user's Chrome). */
  ownsBrowser: boolean;
  screenshotDir: string;
}

/**
 * Thrown when all cascade layers fail. Includes diagnostic info about each
 * attempted layer so the user gets an actionable error message.
 */
export class BrowserAuthCascadeError extends Error {
  readonly attempts: Array<{ layer: string; error: string }>;

  constructor(attempts: Array<{ layer: string; error: string }>) {
    const lines = attempts.map((a, i) => `  ${i + 1}. ${a.layer}: ${a.error}`);
    super(
      'Browser authentication failed. Tried:\n' +
        lines.join('\n') +
        '\n\nFix: Enable remote debugging in Chrome (chrome://inspect/#remote-debugging)\n' +
        'Or run: lobu memory browser-auth --connector <key> --auth-profile-slug <slug>'
    );
    this.name = 'BrowserAuthCascadeError';
    this.attempts = attempts;
  }
}

// ---------------------------------------------------------------------------
// Cascade
// ---------------------------------------------------------------------------

/**
 * Acquire a browser session using a two-layer cascade:
 * CDP first (if available), then Playwright with stored cookies.
 */
export async function acquireBrowser(opts: AcquireBrowserOptions): Promise<AcquiredBrowser> {
  const attempts: Array<{ layer: string; error: string }> = [];

  // --- Layer 1: CDP ---
  if (opts.cdpUrl !== null && opts.cdpUrl !== undefined) {
    try {
      return await acquireViaCdp(opts);
    } catch (err: any) {
      attempts.push({ layer: 'CDP', error: err.message });
      sdkLogger.info(
        { error: err.message },
        '[BrowserAcquire] CDP not available, trying Playwright'
      );
    }
  }

  // --- Layer 2: Playwright (with stored cookies if available) ---
  try {
    return await acquireViaPlaywright(opts);
  } catch (err: any) {
    attempts.push({ layer: 'Playwright', error: err.message });
  }

  // --- All layers failed ---
  throw new BrowserAuthCascadeError(attempts);
}

// ---------------------------------------------------------------------------
// Layer implementations
// ---------------------------------------------------------------------------

async function acquireViaCdp(opts: AcquireBrowserOptions): Promise<AcquiredBrowser> {
  const wsUrl = await resolveCdpUrl(opts.cdpUrl === 'auto' ? 'auto' : opts.cdpUrl, {
    loggerLabel: 'BrowserAcquire',
    preferRealBrowser: true,
  });

  const cdpPage = await CdpPage.create(wsUrl);

  sdkLogger.info({ wsUrl }, '[BrowserAcquire] Connected via raw CDP');

  return {
    browser: null,
    context: null,
    page: null,
    cdpPage,
    cdpWsUrl: wsUrl,
    backend: 'cdp',
    ownsBrowser: false,
    screenshotDir: '/tmp/feed-screenshots',
  };
}

async function acquireViaPlaywright(opts: AcquireBrowserOptions): Promise<AcquiredBrowser> {
  const { browser, screenshotDir } = await launchBrowser({} as never, {
    stealth: opts.stealth ?? false,
  });

  const context = (await (browser as Browser).newContext()) as BrowserContext;
  if (opts.cookies.length > 0) {
    await context.addCookies(opts.cookies);
  }

  sdkLogger.info(
    { cookies: opts.cookies.length },
    '[BrowserAcquire] Launched Playwright with stored cookies'
  );

  const page = await context.newPage();

  return {
    browser: browser as Browser,
    context,
    page,
    cdpPage: null,
    cdpWsUrl: null,
    backend: 'playwright',
    ownsBrowser: true,
    screenshotDir,
  };
}
