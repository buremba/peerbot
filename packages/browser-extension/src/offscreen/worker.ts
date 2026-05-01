/**
 * Offscreen Document Worker
 * Handles DOM operations when the browser is in the background
 * Uses the Offscreen Documents API for invisible DOM operations
 */

console.log('[Owletto] Offscreen document loaded');

// Listen for messages from the service worker
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.log('[Owletto Offscreen] Message received:', message.type);

  switch (message.type) {
    case 'EXTRACT_PAGE':
      handleExtractPage(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ success: false, error: error.message }));
      return true;

    case 'PARSE_HTML':
      handleParseHtml(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ success: false, error: error.message }));
      return true;

    default:
      console.warn('[Owletto Offscreen] Unknown message type:', message.type);
      return false;
  }
});

/**
 * Extract content from a page URL
 */
async function handleExtractPage(message: {
  url: string;
  config: {
    container: string;
    fields: Record<string, { selector: string; attribute?: string; transform?: string }>;
  };
}): Promise<{ success: boolean; items?: unknown[]; error?: string }> {
  try {
    // Fetch the page
    const response = await fetch(message.url, {
      credentials: 'include', // Include cookies for auth
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const html = await response.text();
    const items = parseHtml(html, message.config);

    return { success: true, items };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Parse HTML content with config
 */
async function handleParseHtml(message: {
  html: string;
  config: {
    container: string;
    fields: Record<string, { selector: string; attribute?: string; transform?: string }>;
  };
}): Promise<{ success: boolean; items?: unknown[]; error?: string }> {
  try {
    const items = parseHtml(message.html, message.config);
    return { success: true, items };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Parse HTML using config selectors
 */
function parseHtml(
  html: string,
  config: {
    container: string;
    fields: Record<string, { selector: string; attribute?: string; transform?: string }>;
  }
): unknown[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const containers = doc.querySelectorAll(config.container);
  const items: unknown[] = [];

  for (const container of containers) {
    const item: Record<string, unknown> = {};

    for (const [fieldName, fieldConfig] of Object.entries(config.fields)) {
      const element = container.querySelector(fieldConfig.selector);

      if (element) {
        let value: string | null = null;

        if (fieldConfig.attribute) {
          value = element.getAttribute(fieldConfig.attribute);
        } else {
          value = element.textContent?.trim() || null;
        }

        if (value && fieldConfig.transform) {
          value = applyTransform(value, fieldConfig.transform);
        }

        item[fieldName] = value;
      }
    }

    // Only add if we got at least some fields
    if (Object.keys(item).length > 0) {
      items.push(item);
    }
  }

  return items;
}

/**
 * Apply transform to extracted value
 */
function applyTransform(value: string, transform: string): string | null {
  switch (transform) {
    case 'text':
      return value.trim();
    case 'number': {
      const num = parseFloat(value.replace(/[^0-9.-]/g, ''));
      return Number.isNaN(num) ? null : String(num);
    }
    case 'date': {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    case 'html':
      return value;
    default:
      return value;
  }
}
