/**
 * Shared utilities for browser-based scraper connectors.
 *
 * Provides common patterns used across Trustpilot, G2, Glassdoor, Capterra,
 * and similar connectors that launch a stealth browser and scrape review pages.
 */

import {
  acquireBrowser,
  type CdpPage,
  captureErrorArtifacts,
  type EventEnvelope,
} from '@lobu/connector-sdk';
import type { Browser, Cookie, Page } from 'playwright';

// -----------------------------------------------------------------------------
// Browser auth cookie helpers
// -----------------------------------------------------------------------------

export function getBrowserCookies(
  checkpoint: Record<string, unknown> | null,
  sessionState: Record<string, unknown> | null | undefined,
  connectorKey: string
): any[] {
  const sessionCookies = (sessionState?.cookies as any[]) ?? [];
  const cookies = (checkpoint as any)?.cookies ?? sessionCookies;
  if (!cookies || cookies.length === 0) {
    throw new Error(
      `No browser cookies found. Run: lobu memory browser-auth --connector ${connectorKey} --auth-profile-slug <SLUG>`
    );
  }
  return cookies;
}

export function validateCookieNotExpired(
  cookies: any[],
  cookieName: string,
  connectorKey: string
): void {
  const cookie = cookies.find((c: any) => c.name === cookieName);
  if (cookie?.expires && cookie.expires > 0) {
    const expiresAt = new Date(cookie.expires * 1000);
    if (expiresAt < new Date()) {
      throw new Error(
        `${cookieName} expired on ${expiresAt.toISOString()}. Re-run: lobu memory browser-auth --connector ${connectorKey} --auth-profile-slug <SLUG>`
      );
    }
  }
}

// -----------------------------------------------------------------------------
// URL validation
// -----------------------------------------------------------------------------

/**
 * Validate that a URL is well-formed, uses HTTPS, and belongs to the expected
 * domain (hostname ends with `expectedDomain`).
 *
 * @throws If the URL is invalid, not HTTPS, or on the wrong domain.
 */
export function validateUrlDomain(url: string, expectedDomain: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid ${expectedDomain} URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${expectedDomain} URL must use https: protocol, got ${parsed.protocol}`);
  }
  if (!parsed.hostname.endsWith(expectedDomain)) {
    throw new Error(`URL must be on ${expectedDomain}, got ${parsed.hostname}`);
  }
}

// -----------------------------------------------------------------------------
// Browser lifecycle
// -----------------------------------------------------------------------------

export interface BrowserSession {
  /** Playwright Browser (null when using raw CDP). */
  browser: Browser | null;
  /** Page handle — Playwright Page or CdpPage. Both support goto/evaluate/waitForSelector. */
  page: Page | CdpPage;
  screenshotDir: string;
  /** Which backend was used ('cdp' or 'playwright'). */
  backend: 'cdp' | 'playwright';
  /** If false, don't close the browser (CDP — it's the user's Chrome). */
  ownsBrowser: boolean;
}

/**
 * Acquire a stealth browser session.
 *
 * By default launches a fresh Playwright browser (safe for DOM scraping).
 * Pass `cdpUrl: 'auto'` to try CDP first — uses raw CDP protocol to avoid
 * Playwright's connectOverCDP crash on browsers with many tabs.
 */
export async function openStealthBrowser(opts?: {
  cdpUrl?: string | 'auto' | null;
  cookies?: Cookie[];
  authDomains?: string[];
}): Promise<BrowserSession> {
  const acquired = await acquireBrowser({
    cdpUrl: opts?.cdpUrl ?? null,
    cookies: opts?.cookies ?? [],
    authDomains: opts?.authDomains ?? [],
    stealth: true,
  });

  const page = acquired.cdpPage ?? acquired.page;
  if (!page) throw new Error('No page available from browser acquisition');

  return {
    browser: acquired.browser,
    page,
    screenshotDir: acquired.screenshotDir,
    backend: acquired.backend,
    ownsBrowser: acquired.ownsBrowser,
  };
}

// -----------------------------------------------------------------------------
// Cookie consent
// -----------------------------------------------------------------------------

/**
 * Attempt to dismiss a cookie consent banner by clicking an accept button.
 *
 * @param page    - Playwright page instance
 * @param selector - CSS selector for the accept/dismiss button
 * @param timeout  - How long to wait for the button to appear (ms, default 2000)
 */
export async function handleCookieConsent(
  page: Page | CdpPage,
  selector: string,
  timeout = 2000
): Promise<void> {
  try {
    const found = await page.waitForSelector(selector, { timeout });
    if (found) {
      // CdpPage.waitForSelector returns boolean, Playwright returns ElementHandle
      if (typeof found === 'boolean') {
        await (page as CdpPage).click(selector);
      } else {
        await found.click();
      }
    }
  } catch {
    // No cookie banner found or already dismissed — continue
  }
}

// -----------------------------------------------------------------------------
// Checkpoint filtering
// -----------------------------------------------------------------------------

/**
 * Filter events that are newer than the checkpoint's `last_timestamp`.
 * If no checkpoint is set, all events are returned.
 */
export function filterByCheckpoint(
  events: EventEnvelope[],
  checkpoint: Record<string, unknown> | null
): EventEnvelope[] {
  const lastTimestamp = checkpoint?.last_timestamp as string | undefined;
  if (!lastTimestamp) return events;

  const cutoff = new Date(lastTimestamp);
  return events.filter((e) => e.occurred_at > cutoff);
}

// -----------------------------------------------------------------------------
// Error handling with browser cleanup
// -----------------------------------------------------------------------------

/**
 * Run a scraper function inside a try/catch that captures error artifacts
 * (screenshot + HTML snapshot) and ensures the browser is always closed.
 *
 * @param session       - The browser session from `openStealthBrowser()`
 * @param connectorName - Short name used for artifact filenames (e.g. "trustpilot-sync")
 * @param fn            - The async scraper logic receiving the page
 * @returns             - Whatever `fn` returns
 */
export async function withBrowserErrorCapture<T>(
  session: BrowserSession,
  connectorName: string,
  fn: (page: Page | CdpPage) => Promise<T>
): Promise<T> {
  try {
    return await fn(session.page);
  } catch (error: any) {
    // captureErrorArtifacts only works with Playwright pages
    if (session.backend === 'playwright' && session.page) {
      await captureErrorArtifacts(
        session.page as Page,
        error,
        connectorName,
        session.screenshotDir
      );
    }
    throw error;
  } finally {
    if (session.backend === 'cdp') {
      await (session.page as CdpPage).close();
    } else if (session.ownsBrowser && session.browser) {
      await session.browser.close();
    }
  }
}
