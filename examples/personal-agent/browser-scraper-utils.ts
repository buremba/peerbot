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
} from "@lobu/connector-sdk";
import type { Browser, Cookie, Page } from "playwright";

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
  // Device-bound browser profiles ship cookies via --user-data-dir on disk
  // rather than this jsonb blob; the persistent context loads them itself.
  if ((!cookies || cookies.length === 0) && !sessionState?.user_data_dir) {
    throw new Error(
      `No browser cookies found. Run: lobu memory browser-auth --connector ${connectorKey} --auth-profile-slug <SLUG>`
    );
  }
  return cookies ?? [];
}

/**
 * Pull the device-bound managed --user-data-dir from session_state, if the
 * connection's auth profile is owned by a device worker. When set, callers
 * should pass it to openStealthBrowser instead of relying on the cookies/CDP
 * cascade — Chrome reads cookies from that profile dir directly.
 */
export function getBrowserUserDataDir(
  sessionState: Record<string, unknown> | null | undefined
): string | undefined {
  const value = sessionState?.user_data_dir;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Pull the device-bound CDP endpoint URL from session_state (set when the
 * user picked "Attach via CDP" mode on their browser profile). When set,
 * callers should pass it through as `cdpUrl` so the connector attaches to
 * the exact running Chrome the user chose — instead of `'auto'`, which can
 * land on the wrong browser when several debuggable Chromiums are running
 * or a non-default port was configured.
 */
export function getBrowserCdpUrl(
  sessionState: Record<string, unknown> | null | undefined
): string | undefined {
  const value = sessionState?.cdp_url;
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
 * Validates a URL is safe for server-side fetching.
 * Blocks private/internal network addresses to prevent SSRF attacks.
 *
 * Returns silently when the URL is safe; throws with a descriptive message
 * otherwise. Connectors that fetch URLs derived from remote/untrusted input
 * (sitemaps, HN story links, RSS feeds configured by users, etc.) MUST call
 * this at the trust boundary before issuing the request.
 */
export function validatePublicUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `URL must use http: or https: protocol, got ${parsed.protocol}`
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost variants
  if (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  ) {
    throw new Error(`URL must not point to localhost: ${hostname}`);
  }

  // IPv4 private/loopback/link-local/cloud-metadata/CGNAT ranges
  const ipv4Match = hostname.match(
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
  );
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (
      a === 127 || // loopback
      a === 10 || // private
      (a === 172 && b >= 16 && b <= 31) || // private
      (a === 192 && b === 168) || // private
      (a === 169 && b === 254) || // link-local incl. 169.254.169.254 cloud metadata
      (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
      a === 0
    ) {
      throw new Error(
        `URL must not point to a private/internal IP address: ${hostname}`
      );
    }
  }

  // IPv6 private ranges (bracketed notation)
  if (hostname.startsWith("[")) {
    const ipv6 = hostname.slice(1, -1).toLowerCase();
    // Link-local fe80::/10 covers fe80:..fec0: (first byte 1111 1110 1x).
    const linkLocalPrefix = /^fe[89ab][0-9a-f]?:/;
    // Multicast ff00::/8 — any address starting with ff.
    const multicastPrefix = /^ff[0-9a-f]{2}:/;
    if (
      ipv6 === "::1" ||
      linkLocalPrefix.test(ipv6) ||
      multicastPrefix.test(ipv6) ||
      ipv6.startsWith("fc") || // unique local fc00::/7
      ipv6.startsWith("fd") ||
      ipv6 === "::" ||
      ipv6.startsWith("::ffff:") // IPv4-mapped IPv6
    ) {
      throw new Error(
        `URL must not point to a private/internal IPv6 address: ${hostname}`
      );
    }
  }

  // Common internal hostnames
  if (
    hostname.endsWith(".internal") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".corp") ||
    hostname.endsWith(".lan")
  ) {
    throw new Error(`URL must not point to an internal hostname: ${hostname}`);
  }
}

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
  if (parsed.protocol !== "https:") {
    throw new Error(
      `${expectedDomain} URL must use https: protocol, got ${parsed.protocol}`
    );
  }
  if (
    parsed.hostname !== expectedDomain &&
    !parsed.hostname.endsWith(`.${expectedDomain}`)
  ) {
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
  backend: "cdp" | "playwright";
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
  cdpUrl?: string | "auto" | null;
  cookies?: Cookie[];
  authDomains?: string[];
  userDataDir?: string;
}): Promise<BrowserSession> {
  const acquired = await acquireBrowser({
    cdpUrl: opts?.userDataDir ? null : (opts?.cdpUrl ?? null),
    cookies: opts?.cookies ?? [],
    authDomains: opts?.authDomains ?? [],
    stealth: true,
    userDataDir: opts?.userDataDir,
  });

  const page = acquired.cdpPage ?? acquired.page;
  if (!page) throw new Error("No page available from browser acquisition");

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
      if (typeof found === "boolean") {
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
    if (session.backend === "playwright" && session.page) {
      await captureErrorArtifacts(
        session.page as Page,
        error,
        connectorName,
        session.screenshotDir
      );
    }
    throw error;
  } finally {
    if (session.backend === "cdp") {
      await (session.page as CdpPage).close();
    } else if (session.ownsBrowser && session.browser) {
      await session.browser.close();
    }
  }
}
