/**
 * Owletto Content Script
 * Runs on web pages to detect supported platforms and extract content
 */

import {
  type ExtractionResult,
  type ExtractorConfig,
  extractFromPage,
  scrollForMore,
} from './dom-interpreter';

// Platform URL patterns for detection
const PLATFORM_PATTERNS: Record<string, RegExp[]> = {
  trustpilot: [/trustpilot\.com\/review\//],
  reddit: [/reddit\.com\/r\//],
  github: [/github\.com\/[\w-]+\/[\w-]+\/(issues|discussions|pulls)/],
  hackernews: [/news\.ycombinator\.com/],
  g2: [/g2\.com\/products\//],
  capterra: [/capterra\.com\/reviews\//],
  glassdoor: [/glassdoor\.com\/Reviews\//],
  google_maps: [/google\.com\/maps\/place\//],
  ios_appstore: [/apps\.apple\.com\/.*\/app\//],
  google_play: [/play\.google\.com\/store\/apps\//],
  x: [/x\.com\/|twitter\.com\//],
};

/**
 * Detect which platform the current page is on
 */
function detectPlatform(): string | null {
  const url = window.location.href;

  for (const [platform, patterns] of Object.entries(PLATFORM_PATTERNS)) {
    if (patterns.some((pattern) => pattern.test(url))) {
      return platform;
    }
  }

  return null;
}

/**
 * Notify the background script about platform detection
 */
function notifyPlatformDetected(platform: string): void {
  chrome.runtime.sendMessage({
    type: 'PLATFORM_DETECTED',
    platform,
    url: window.location.href,
  });
}

/**
 * Initialize content script
 */
function init(): void {
  console.log('[Owletto] Content script loaded');

  const platform = detectPlatform();

  if (platform) {
    console.log(`[Owletto] Detected platform: ${platform}`);
    notifyPlatformDetected(platform);
  }
}

// Run on page load
init();

// Also listen for SPA navigation
let lastUrl = window.location.href;
const observer = new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    init();
  }
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
});

/**
 * Handle extraction request from service worker
 */
async function handleExtraction(config: ExtractorConfig): Promise<ExtractionResult> {
  console.log(`[Owletto] Starting extraction for ${config.platform}`);

  // Wait for page to be fully loaded
  if (document.readyState !== 'complete') {
    await new Promise<void>((resolve) => {
      window.addEventListener('load', () => resolve(), { once: true });
    });
  }

  // Wait a bit more for dynamic content
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Handle infinite scroll if needed
  if (config.selectors.pagination?.type === 'infinite_scroll') {
    await scrollForMore(config, 3);
  }

  // Extract content
  const result = extractFromPage(config);

  return result;
}

// Listen for extraction requests from background
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'EXTRACT_CONTENT') {
    console.log('[Owletto] Extraction requested:', message);

    if (!message.config) {
      sendResponse({ success: false, error: 'No extractor config provided' });
      return true;
    }

    handleExtraction(message.config)
      .then((result) => {
        console.log('[Owletto] Extraction complete:', result.items.length, 'items');
        sendResponse(result);
      })
      .catch((error) => {
        console.error('[Owletto] Extraction failed:', error);
        sendResponse({
          success: false,
          items: [],
          hasNextPage: false,
          error: error instanceof Error ? error.message : 'Extraction failed',
        });
      });

    return true; // Indicates async response
  }

  if (message.type === 'PING') {
    sendResponse({ success: true, url: window.location.href });
    return false;
  }

  return true;
});
