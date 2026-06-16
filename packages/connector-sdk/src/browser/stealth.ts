/// <reference lib="dom" />
/**
 * Stealth Browser Helper
 * Provides browser instances that mimic real browsers to avoid CAPTCHA and bot detection
 */

type Browser = any;
type BrowserContext = any;
type Page = any;

import { sdkLogger } from '../logger.js';

interface StealthBrowserOptions {
  headless?: boolean;
  debug?: boolean;
  userAgent?: string;
  viewport?: { width: number; height: number };
  timezoneId?: string;
  locale?: string;
  proxy?: {
    server: string;
    username?: string;
    password?: string;
  };
}

interface StealthBrowser {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

/**
 * Default user agents (rotate through these for better stealth)
 */
const DEFAULT_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
];

function getRandomUserAgent(): string {
  return DEFAULT_USER_AGENTS[Math.floor(Math.random() * DEFAULT_USER_AGENTS.length)];
}

/**
 * Launch a stealth browser instance
 */
export async function launchStealthBrowser(
  options: StealthBrowserOptions = {}
): Promise<StealthBrowser> {
  const {
    headless = true,
    debug = false,
    userAgent = getRandomUserAgent(),
    viewport = { width: 1920, height: 1080 },
    timezoneId = 'America/New_York',
    locale = 'en-US',
    proxy,
  } = options;

  // patchright (drop-in playwright replacement) handles navigator.webdriver natively
  const playwrightModule = 'playwright';
  const { chromium } = await import(/* @vite-ignore */ playwrightModule);

  const browser: Browser = await chromium.launch({
    headless: headless && !debug,
    slowMo: debug ? 100 : 0,
    devtools: debug,
    args: getStealthArgs(),
    proxy,
  });

  sdkLogger.info('[StealthBrowser] Using patchright with stealth flags');

  const context = await browser.newContext({
    userAgent,
    viewport,
    locale,
    timezoneId,
    deviceScaleFactor: 1,
    hasTouch: false,
    colorScheme: 'light',
    permissions: ['geolocation', 'notifications'],
    extraHTTPHeaders: getRealisticHeaders(),
  });

  const page = await context.newPage();

  return {
    browser,
    context,
    page,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

function getStealthArgs(): string[] {
  return [
    '--disable-blink-features=AutomationControlled',
    '--exclude-switches=enable-automation',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-extensions',
    '--disable-infobars',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--enable-webgl',
    '--use-gl=swiftshader',
    '--enable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-component-extensions-with-background-pages',
    '--disable-features=TranslateUI',
    '--disable-ipc-flooding-protection',
    '--disable-renderer-backgrounding',
    '--metrics-recording-only',
    '--mute-audio',
  ];
}

function getRealisticHeaders(): Record<string, string> {
  return {
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
  };
}
