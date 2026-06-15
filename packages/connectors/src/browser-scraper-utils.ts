/**
 * Shared utilities for browser-based scraper connectors.
 *
 * Provides common patterns used across Trustpilot, G2, Glassdoor, Capterra,
 * and similar connectors that launch a stealth browser and scrape review pages.
 */

import {
  type ActionResult,
  acquireBrowser,
  type CdpPage,
  captureErrorArtifacts,
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';
import type { Browser, Cookie, Page } from 'playwright';

// -----------------------------------------------------------------------------
// Timing
// -----------------------------------------------------------------------------

/** Resolve after `ms` milliseconds. Shared across scraper rate-limit/delay loops. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -----------------------------------------------------------------------------
// Browser auth helpers
// -----------------------------------------------------------------------------

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
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`URL must use http: or https: protocol, got ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost variants
  if (hostname === 'localhost' || hostname === '[::1]' || hostname.endsWith('.localhost')) {
    throw new Error(`URL must not point to localhost: ${hostname}`);
  }

  // IPv4 private/loopback/link-local/cloud-metadata/CGNAT ranges
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
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
      throw new Error(`URL must not point to a private/internal IP address: ${hostname}`);
    }
  }

  // IPv6 private ranges (bracketed notation)
  if (hostname.startsWith('[')) {
    const ipv6 = hostname.slice(1, -1).toLowerCase();
    // Link-local fe80::/10 covers fe80:..fec0: (first byte 1111 1110 1x).
    const linkLocalPrefix = /^fe[89ab][0-9a-f]?:/;
    // Multicast ff00::/8 — any address starting with ff.
    const multicastPrefix = /^ff[0-9a-f]{2}:/;
    if (
      ipv6 === '::1' ||
      linkLocalPrefix.test(ipv6) ||
      multicastPrefix.test(ipv6) ||
      ipv6.startsWith('fc') || // unique local fc00::/7
      ipv6.startsWith('fd') ||
      ipv6 === '::' ||
      ipv6.startsWith('::ffff:') // IPv4-mapped IPv6
    ) {
      throw new Error(`URL must not point to a private/internal IPv6 address: ${hostname}`);
    }
  }

  // Common internal hostnames
  if (
    hostname.endsWith('.internal') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.corp') ||
    hostname.endsWith('.lan')
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
  if (parsed.protocol !== 'https:') {
    throw new Error(`${expectedDomain} URL must use https: protocol, got ${parsed.protocol}`);
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

/**
 * Drop events older than `lookbackDays` before now. Bounds the emit window so a
 * full-history scrape doesn't re-ingest stale reviews on every recurring sync.
 * A non-positive/undefined `lookbackDays` leaves events untouched.
 */
export function applyLookbackCutoff(
  events: EventEnvelope[],
  lookbackDays: number | undefined
): EventEnvelope[] {
  if (!lookbackDays || lookbackDays <= 0) return events;
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  return events.filter((e) => e.occurred_at >= cutoff);
}

/**
 * Build the next checkpoint for a review scraper after lookback + checkpoint
 * filtering. Advances `last_timestamp` to the newest emitted event, falling
 * back to the prior checkpoint's value when nothing new was emitted, and merges
 * any extra fields (e.g. `last_sync_at`, `last_page`). Mirrors gmaps.ts so all
 * review scrapers checkpoint identically.
 */
export function buildReviewCheckpoint(
  events: EventEnvelope[],
  previous: Record<string, unknown> | null,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const priorTimestamp = (previous?.last_timestamp as string | undefined) ?? null;
  return {
    ...extra,
    last_timestamp: events.length > 0 ? events[0].occurred_at.toISOString() : priorTimestamp,
  };
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

// -----------------------------------------------------------------------------
// Bridge-only connector base
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Review scraper driver
// -----------------------------------------------------------------------------

/**
 * What a per-site `extract` returns: the raw (pre-pipeline) events scraped from
 * the page(s), the per-site checkpoint extras to merge, and a `metadata` builder
 * that receives the FINAL (post lookback+checkpoint+sort) events so sites can
 * report either raw or emitted counts.
 */
export interface ReviewExtractResult {
  events: EventEnvelope[];
  checkpointExtra: Record<string, unknown>;
  metadata: (finalEvents: EventEnvelope[]) => Record<string, unknown>;
}

export interface RunReviewScrapeOptions {
  /** Short connector name for error-artifact filenames, e.g. "trustpilot-sync". */
  connectorKey: string;
  /** First page URL to load (already validated/constructed by the caller). */
  baseUrl: string;
  /** Domain the URL must belong to (passed to validateUrlDomain). */
  expectedDomain: string;
  /** CSS selector for the cookie-consent accept button. */
  cookieConsentSelector: string;
  /** CSS selector that review cards match; the driver waits for it after consent. */
  reviewCardSelector: string;
  /** page.goto timeout (ms). */
  gotoTimeoutMs: number;
  /** Optional per-site page setup run before navigation (viewport, headers). */
  prepare?: (page: Page | CdpPage) => Promise<void>;
  /** Optional delay (ms) after cookie consent, before waiting for cards. */
  postConsentDelayMs?: number;
  /**
   * Per-site extraction. Receives the loaded page and whether the review-card
   * selector appeared within the wait window. Returns raw events + checkpoint
   * extras + a metadata builder.
   */
  extract: (page: Page | CdpPage, cardsFound: boolean) => Promise<ReviewExtractResult>;
}

/**
 * Shared driver for browser-based review scrapers (Trustpilot, G2, Capterra,
 * Glassdoor). Owns the session preamble (user-data-dir → cdp → stealth browser →
 * error capture), domain validation, navigation, cookie consent, the review-card
 * wait, and the F11 incremental pipeline: applyLookbackCutoff → filterByCheckpoint
 * → sort newest-first → buildReviewCheckpoint. Each site supplies only its
 * selectors and an `extract` callback.
 */
export async function runReviewScrape(
  ctx: SyncContext,
  opts: RunReviewScrapeOptions
): Promise<SyncResult> {
  validateUrlDomain(opts.baseUrl, opts.expectedDomain);
  const lookbackDays = ctx.config.lookback_days as number | undefined;

  const userDataDir = getBrowserUserDataDir(ctx.sessionState);
  const cdpUrl = getBrowserCdpUrl(ctx.sessionState) ?? 'auto';
  const session = await openStealthBrowser({ cdpUrl, userDataDir });

  return withBrowserErrorCapture(session, opts.connectorKey, async (page) => {
    if (opts.prepare) await opts.prepare(page);

    await page.goto(opts.baseUrl, {
      waitUntil: 'domcontentloaded',
      timeout: opts.gotoTimeoutMs,
    });

    await handleCookieConsent(page, opts.cookieConsentSelector);

    if (opts.postConsentDelayMs) await page.waitForTimeout(opts.postConsentDelayMs);

    let cardsFound = false;
    try {
      await page.waitForSelector(opts.reviewCardSelector, { timeout: 10000 });
      cardsFound = true;
    } catch {
      // Cards never appeared — extract decides whether to bail or continue.
    }

    const extracted = await opts.extract(page, cardsFound);

    // F11 incremental pipeline: bound the emit window to lookback_days, drop
    // already-seen reviews via the checkpoint, then sort newest-first so the
    // checkpoint advances.
    let events = applyLookbackCutoff(extracted.events, lookbackDays);
    events = filterByCheckpoint(events, ctx.checkpoint);
    events.sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());

    return {
      events,
      checkpoint: buildReviewCheckpoint(events, ctx.checkpoint, {
        last_sync_at: new Date().toISOString(),
        ...extracted.checkpointExtra,
      }),
      metadata: extracted.metadata(events),
    };
  });
}
