import type { EventEnvelope, SyncContext, SyncResult } from '../connector-types.js';
import { finalizeTimestampSync } from '../checkpoint/timestamp-watermark.js';
import { validateUrlDomain } from '../url-guards.js';
import { captureErrorArtifacts, launchBrowser } from './launcher.js';
import type { Browser, Page } from 'playwright';

interface BrowserSession {
  browser: Browser;
  page: Page;
  screenshotDir: string;
}

async function openHeadlessBrowser(): Promise<BrowserSession> {
  const { browser, screenshotDir } = await launchBrowser({ stealth: true });
  const page = (await browser.newPage()) as Page;
  return { browser, page, screenshotDir };
}

export async function handleCookieConsent(
  page: Page,
  selector: string,
  timeout = 2000
): Promise<void> {
  try {
    const found = await page.waitForSelector(selector, { timeout });
    if (found) await found.click();
  } catch {
    // No cookie banner — continue
  }
}

async function withBrowserErrorCapture<T>(
  session: BrowserSession,
  connectorName: string,
  fn: (page: Page) => Promise<T>
): Promise<T> {
  try {
    return await fn(session.page);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    await captureErrorArtifacts(session.page, err, connectorName, session.screenshotDir);
    throw error;
  } finally {
    await session.browser.close();
  }
}

export interface ReviewExtractResult {
  events: EventEnvelope[];
  checkpointExtra: Record<string, unknown>;
  metadata: (finalEvents: EventEnvelope[]) => Record<string, unknown>;
}

export interface RunReviewScrapeOptions {
  connectorKey: string;
  baseUrl: string;
  expectedDomain: string;
  cookieConsentSelector: string;
  reviewCardSelector: string;
  gotoTimeoutMs: number;
  prepare?: (page: Page) => Promise<void>;
  postConsentDelayMs?: number;
  extract: (page: Page, cardsFound: boolean) => Promise<ReviewExtractResult>;
}

export async function runReviewScrape(
  ctx: SyncContext,
  opts: RunReviewScrapeOptions
): Promise<SyncResult> {
  validateUrlDomain(opts.baseUrl, opts.expectedDomain);
  const lookbackDays = ctx.config.lookback_days as number | undefined;
  const session = await openHeadlessBrowser();

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
      // extract decides whether to bail
    }

    const extracted = await opts.extract(page, cardsFound);
    const { events, checkpoint } = finalizeTimestampSync(extracted.events, ctx.checkpoint, {
      lookbackDays,
      extra: {
        last_sync_at: new Date().toISOString(),
        ...extracted.checkpointExtra,
      },
    });

    return {
      events,
      checkpoint,
      metadata: extracted.metadata(events),
    };
  });
}