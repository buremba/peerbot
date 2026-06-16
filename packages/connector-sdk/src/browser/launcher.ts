/// <reference lib="dom" />
/**
 * Browser Launcher Utility
 * Provides Playwright-based browser automation
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sdkLogger } from '../logger.js';
import { launchStealthBrowser } from './stealth.js';

export interface BrowserLaunchOptions {
  debug?: boolean;
  trace?: boolean;
  screenshotDir?: string;
  stealth?: boolean;
}

export interface EnhancedBrowser {
  browser: any;
  isPlaywright: boolean;
  screenshotDir: string;
}

/** Add Puppeteer-compatible `setUserAgent` to a Playwright Page. */
function addCompatibilityMethods(page: any): any {
  if (!page.setUserAgent) {
    page.setUserAgent = async (userAgent: string) => {
      await page.setExtraHTTPHeaders({ 'User-Agent': userAgent });
    };
  }
  return page;
}

/**
 * Launch browser with Playwright
 */
export async function launchBrowser(
  options: BrowserLaunchOptions = {}
): Promise<EnhancedBrowser> {
  const isDebug = options.debug ?? process.env.BROWSER_DEBUG === '1';
  const enableTrace = options.trace ?? process.env.BROWSER_TRACE === '1';
  const screenshotDir =
    options.screenshotDir ?? process.env.BROWSER_SCREENSHOT_DIR ?? '/tmp/feed-screenshots';

  const useStealth = options.stealth ?? process.env.BROWSER_STEALTH === '1';

  sdkLogger.info(
    `[BrowserLauncher] Using Playwright (local) - headless: ${!isDebug}, stealth: ${useStealth}`
  );

  try {
    if (useStealth) {
      const stealthBrowser = await launchStealthBrowser({
        headless: !isDebug,
        debug: isDebug,
      });

      const browser = stealthBrowser.browser;
      const originalNewPage = browser.newPage.bind(browser);

      browser.newPage = async () => {
        const page = await originalNewPage();
        return addCompatibilityMethods(page);
      };

      sdkLogger.info('[BrowserLauncher] Stealth mode enabled - using anti-detection measures');

      return {
        browser,
        isPlaywright: true,
        screenshotDir,
      };
    }

    const playwrightModule = 'playwright';
    const { chromium } = await import(/* @vite-ignore */ playwrightModule);

    const browser = await chromium.launch({
      headless: !isDebug,
      slowMo: isDebug ? 100 : 0,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      devtools: isDebug,
    });

    const originalNewPage = browser.newPage.bind(browser);
    browser.newPage = async () => {
      const page = await originalNewPage();
      return addCompatibilityMethods(page);
    };

    if (isDebug) {
      sdkLogger.info('[BrowserLauncher] Debug mode enabled - browser visible, slow motion active');
    }

    if (enableTrace) {
      sdkLogger.info(
        '[BrowserLauncher] Trace recording enabled - artifacts will be saved on error'
      );
    }

    return {
      browser,
      isPlaywright: true,
      screenshotDir,
    };
  } catch (error: any) {
    if (error.message?.includes("Executable doesn't exist") || error.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        'Playwright not installed or Chromium browser missing.\n' +
          'Install with: npm install -D playwright && npx playwright install chromium'
      );
    }

    sdkLogger.error({ error }, '[BrowserLauncher] Failed to launch Playwright browser:');
    throw new Error(`Playwright launch failed: ${error.message}`);
  }
}

/**
 * Capture error artifacts (screenshot, HTML, trace) when feed fails
 */
export async function captureErrorArtifacts(
  page: any,
  error: Error,
  feedType: string,
  screenshotDir: string
): Promise<void> {
  try {
    await mkdir(screenshotDir, { recursive: true });

    // feedType is caller-controlled and lands in on-disk filenames. Strip
    // path separators, parent-dir references, and any non-filename-safe
    // characters to prevent traversal outside screenshotDir.
    const safeFeedType =
      (typeof feedType === 'string' ? feedType : 'unknown')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/^\.+/, '_')
        .slice(0, 64) || 'unknown';

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseFilename = `${safeFeedType}-${timestamp}`;

    const screenshotPath = join(screenshotDir, `${baseFilename}.png`);
    try {
      await page.screenshot({
        path: screenshotPath,
        fullPage: true,
        timeout: 5000,
      });
      sdkLogger.error({ path: screenshotPath }, '[BrowserLauncher] Screenshot saved');
    } catch (screenshotError) {
      sdkLogger.warn({ error: screenshotError }, '[BrowserLauncher] Failed to capture screenshot');
    }

    const htmlPath = join(screenshotDir, `${baseFilename}.html`);
    try {
      const html = await page.content();
      await writeFile(htmlPath, html, 'utf-8');
      sdkLogger.error({ path: htmlPath }, '[BrowserLauncher] HTML saved');
    } catch (htmlError) {
      sdkLogger.warn({ error: htmlError }, '[BrowserLauncher] Failed to save HTML');
    }

    const logsPath = join(screenshotDir, `${baseFilename}.log`);
    try {
      const logs = await page
        .evaluate(() => {
          return (window.console as unknown as { history?: string[] })?.history || [];
        })
        .catch(() => []);

      if (logs.length > 0) {
        await writeFile(logsPath, logs.join('\n'), 'utf-8');
        sdkLogger.error(`[BrowserLauncher] Console logs saved: ${logsPath}`);
      }
    } catch (_logError) {
      // Console logs are optional
    }

    sdkLogger.error(
      {
        feed_type: feedType,
        error: error.message,
        stack: error.stack,
        artifacts: {
          directory: screenshotDir,
          screenshot: screenshotPath,
          html: htmlPath,
        },
        debug_hint: `To debug: BROWSER_DEBUG=1 pnpm sync ${safeFeedType} [options]`,
      },
      '[BrowserLauncher] Feed failed'
    );
  } catch (captureError) {
    sdkLogger.error({ error: captureError }, '[BrowserLauncher] Failed to capture error artifacts');
  }
}
