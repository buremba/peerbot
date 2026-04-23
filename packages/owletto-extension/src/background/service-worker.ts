/**
 * Owletto Service Worker
 * The heart of the extension - handles scheduling, API communication, and job execution
 */

import { ApiClient, type Job } from './api-client';
import { AuthManager } from './auth';
import { type ExtractorDefinition, StateManager } from './state-manager';

// Initialize managers
const state = new StateManager();
const auth = new AuthManager(state);
const api = new ApiClient(auth, state);

// Constants
const POLL_ALARM_NAME = 'owletto-poll';
const POLL_INTERVAL_MINUTES = 1;

/**
 * Extension install/update handler
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Owletto] Extension installed/updated:', details.reason);

  // Set up polling alarm
  await chrome.alarms.create(POLL_ALARM_NAME, {
    periodInMinutes: POLL_INTERVAL_MINUTES,
  });
});

/**
 * Alarm handler - triggers job polling
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === POLL_ALARM_NAME) {
    console.log('[Owletto] Poll alarm triggered');
    await pollForJobs();
  }
});

/**
 * Poll server for available jobs
 */
async function pollForJobs(): Promise<void> {
  try {
    const isLoggedIn = await auth.isLoggedIn();
    if (!isLoggedIn) {
      console.log('[Owletto] Not logged in, skipping poll');
      return;
    }

    const jobs = await api.poll();
    console.log(`[Owletto] Polled ${jobs.length} jobs`);

    for (const job of jobs) {
      await executeJob(job);
    }
  } catch (error) {
    console.error('[Owletto] Poll error:', error);
  }
}

/**
 * Execute a single sync job
 */
async function executeJob(job: Job): Promise<void> {
  console.log(`[Owletto] Executing run ${job.run_id} for ${job.connector_key}`);

  await state.addActivityLog({
    type: 'sync_started',
    platform: job.connector_key,
    message: `Starting sync for ${job.connector_key}`,
    details: { run_id: job.run_id },
  });

  try {
    // Get extractor config
    const config = await state.getExtractorConfig(job.connector_key);
    if (!config) {
      throw new Error(`No extractor config found for platform: ${job.connector_key}`);
    }

    // Build target URL from job options
    const targetUrl = buildTargetUrl(job);
    console.log(`[Owletto] Target URL: ${targetUrl}`);

    // Execute extraction
    const result = await extractWithTab(targetUrl, config, job);

    await state.addActivityLog({
      type: 'sync_completed',
      platform: job.connector_key,
      message: `Extracted ${result.itemCount} items from ${job.connector_key}`,
      details: { run_id: job.run_id, items: result.itemCount },
    });

    await api.complete(job.run_id, {
      status: 'success',
      items_collected: result.itemCount,
      checkpoint: result.checkpoint,
    });
  } catch (error) {
    console.error(`[Owletto] Run ${job.run_id} failed:`, error);

    await state.addActivityLog({
      type: 'sync_failed',
      platform: job.connector_key,
      message: `Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      details: { run_id: job.run_id },
    });

    await api.complete(job.run_id, {
      status: 'failed',
      error_message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Build target URL from job options
 */
function buildTargetUrl(job: Job): string {
  const options = job.config || {};

  // Platform-specific URL building
  switch (job.connector_key) {
    case 'trustpilot':
      if (options.business_url) return String(options.business_url);
      if (options.business_name)
        return `https://www.trustpilot.com/review/${options.business_name}`;
      break;

    case 'reddit':
      if (options.subreddit) return `https://www.reddit.com/r/${options.subreddit}`;
      break;

    case 'github':
      if (options.repo_owner && options.repo_name) {
        const types = Array.isArray(options.types) ? options.types : [];
        const type = types.length > 0 ? String(types[0]) : 'issues';
        return `https://github.com/${options.repo_owner}/${options.repo_name}/${type}`;
      }
      break;

    case 'hackernews':
      if (options.search_query)
        return `https://hn.algolia.com/?query=${encodeURIComponent(String(options.search_query))}`;
      return 'https://news.ycombinator.com/';

    case 'g2':
      if (options.product_url) return String(options.product_url);
      break;

    case 'capterra':
      if (options.product_url) return String(options.product_url);
      break;

    case 'glassdoor':
      if (options.company_url) return String(options.company_url);
      break;

    case 'google_maps':
      if (options.place_url) return String(options.place_url);
      break;

    case 'ios_appstore':
      if (options.app_url) return String(options.app_url);
      if (options.app_id) return `https://apps.apple.com/app/id${options.app_id}`;
      break;

    case 'google_play':
      if (options.app_url) return String(options.app_url);
      if (options.app_id) return `https://play.google.com/store/apps/details?id=${options.app_id}`;
      break;
  }

  throw new Error(
    `Cannot build URL for ${job.connector_key} with options: ${JSON.stringify(options)}`
  );
}

interface ExtractionResult {
  itemCount: number;
  checkpoint?: Record<string, unknown>;
}

/**
 * Extract content using a browser tab
 */
async function extractWithTab(
  url: string,
  config: ExtractorDefinition,
  job: Job
): Promise<ExtractionResult> {
  // Check if we have permission for this URL
  const hasPermission = await chrome.permissions.contains({
    origins: [`${new URL(url).origin}/*`],
  });

  if (!hasPermission) {
    // Request permission
    const granted = await chrome.permissions.request({
      origins: [`${new URL(url).origin}/*`],
    });

    if (!granted) {
      throw new Error(`Permission denied for ${new URL(url).hostname}`);
    }
  }

  // Create a new tab for extraction
  const tab = await chrome.tabs.create({
    url,
    active: false, // Don't steal focus
  });

  if (!tab.id) {
    throw new Error('Failed to create tab');
  }

  try {
    // Wait for page to load
    await waitForTabLoad(tab.id);

    // Add delay for dynamic content
    await delay(config.rate_limits?.delay_between_pages_ms || 2000);

    // Send extraction request to content script
    const result = await sendExtractionRequest(tab.id, config);

    if (!result.success) {
      throw new Error(result.error || 'Extraction failed');
    }

    // Stream items to server
    if (result.items && result.items.length > 0) {
      await api.stream(job.run_id, result.items);
    }

    // Handle pagination if more pages exist
    let totalItems = result.items?.length || 0;
    let currentPage = 1;
    const maxPages = 10; // Limit pages per run
    let nextResult = result;

    while (nextResult.hasNextPage && nextResult.nextPageUrl && currentPage < maxPages) {
      currentPage++;
      console.log(`[Owletto] Navigating to page ${currentPage}: ${nextResult.nextPageUrl}`);

      await chrome.tabs.update(tab.id, { url: nextResult.nextPageUrl });
      await waitForTabLoad(tab.id);
      await delay(config.rate_limits?.delay_between_pages_ms || 2000);

      nextResult = await sendExtractionRequest(tab.id, config);
      const pageItems = nextResult.items ?? [];

      if (nextResult.success && pageItems.length > 0) {
        await api.stream(job.run_id, pageItems);
        totalItems += pageItems.length;
      }
    }

    return {
      itemCount: totalItems,
      checkpoint: { last_page: currentPage, last_url: url },
    };
  } finally {
    // Clean up - close the tab
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      // Tab might already be closed
    }
  }
}

/**
 * Wait for a tab to finish loading
 */
function waitForTabLoad(tabId: number, timeout = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const checkStatus = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);

        if (tab.status === 'complete') {
          resolve();
          return;
        }

        if (Date.now() - startTime > timeout) {
          reject(new Error('Tab load timeout'));
          return;
        }

        setTimeout(checkStatus, 500);
      } catch (error) {
        reject(error);
      }
    };

    checkStatus();
  });
}

/**
 * Send extraction request to content script
 */
function sendExtractionRequest(
  tabId: number,
  config: ExtractorDefinition
): Promise<{
  success: boolean;
  items?: Array<{ id: string; content: string; [key: string]: unknown }>;
  hasNextPage: boolean;
  nextPageUrl?: string;
  error?: string;
}> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      {
        type: 'EXTRACT_CONTENT',
        config: {
          platform: config.platform,
          version: config.version,
          selectors: config.selectors,
          rate_limits: config.rate_limits,
        },
      },
      (response) => {
        if (chrome.runtime.lastError) {
          // Content script might not be loaded yet
          console.error('[Owletto] Content script error:', chrome.runtime.lastError.message);
          resolve({
            success: false,
            hasNextPage: false,
            error: chrome.runtime.lastError.message,
          });
          return;
        }
        resolve(response || { success: false, hasNextPage: false, error: 'No response' });
      }
    );
  });
}

/**
 * Delay helper
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Message handler - for communication with content scripts and sidebar
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Owletto] Message received:', message.type);

  switch (message.type) {
    case 'GET_AUTH_STATUS':
      auth.isLoggedIn().then((isLoggedIn) => {
        sendResponse({ isLoggedIn });
      });
      return true; // Async response

    case 'LOGIN':
      auth.login().then((result) => {
        sendResponse(result);
      });
      return true;

    case 'LOGOUT':
      auth.logout().then(() => {
        sendResponse({ success: true });
      });
      return true;

    case 'POLL_NOW':
      pollForJobs().then(() => {
        sendResponse({ success: true });
      });
      return true;

    case 'GET_ACTIVITY_LOG':
      state.get('activityLog').then((log) => {
        sendResponse({ log: log || [] });
      });
      return true;

    case 'TEST_EXTRACTION':
      // Test extraction on current tab
      testExtraction(message.tabId, message.platform).then((result) => {
        sendResponse(result);
      });
      return true;

    case 'PLATFORM_DETECTED':
      handlePlatformDetected(message.platform, sender.tab?.id);
      sendResponse({ success: true });
      return false;

    default:
      console.warn('[Owletto] Unknown message type:', message.type);
      return false;
  }
});

/**
 * Handle platform detection from content script
 */
function handlePlatformDetected(platform: string, tabId?: number): void {
  console.log(`[Owletto] Platform detected: ${platform} in tab ${tabId}`);

  // Update badge to show platform is supported
  if (tabId) {
    chrome.action.setBadgeText({ text: '!', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50', tabId });
  }
}

/**
 * Test extraction on a specific tab (for debugging)
 */
async function testExtraction(
  tabId: number,
  platform: string
): Promise<{
  success: boolean;
  items?: unknown[];
  error?: string;
}> {
  try {
    // Get config
    const config = await state.getExtractorConfig(platform);
    if (!config) {
      return { success: false, error: `No cached config for platform: ${platform}` };
    }

    const result = await sendExtractionRequest(tabId, config);
    return {
      success: result.success,
      items: result.items,
      error: result.error,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Test extraction failed',
    };
  }
}

/**
 * Side panel behavior
 */
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('[Owletto] Side panel error:', error));

console.log('[Owletto] Service worker initialized');
