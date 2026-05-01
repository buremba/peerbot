/**
 * DOM Interpreter
 * Executes extractor definitions from server against page DOM
 * All extraction logic comes from server - this is just the runtime
 */

export interface SelectorDef {
  selector: string;
  attribute?: string; // Get attribute value instead of text
  regex?: string; // Extract with regex
  transform?: 'text' | 'html' | 'number' | 'date';
}

export interface ExtractorConfig {
  platform: string;
  version: number;
  selectors: {
    container: string;
    fields: Record<string, SelectorDef>;
    pagination?: {
      type: 'url_param' | 'cursor' | 'infinite_scroll';
      next_button?: string;
      page_param?: string;
      scroll_container?: string;
    };
  };
  rate_limits?: {
    requests_per_minute: number;
    delay_between_pages_ms: number;
  };
}

export interface ExtractedItem {
  id: string;
  content: string;
  title?: string;
  author?: string;
  published_at?: string;
  url?: string;
  metadata: Record<string, unknown>;
}

export interface ExtractionResult {
  success: boolean;
  items: ExtractedItem[];
  hasNextPage: boolean;
  nextPageUrl?: string;
  error?: string;
}

/**
 * Extract a single field value from an element using selector definition
 */
function extractField(element: Element, fieldDef: SelectorDef): string | number | null {
  const target = element.querySelector(fieldDef.selector);
  if (!target) return null;

  // Get raw value
  let value: string;
  if (fieldDef.attribute) {
    value = target.getAttribute(fieldDef.attribute) || '';
  } else {
    value = target.textContent?.trim() || '';
  }

  // Apply regex if specified
  if (fieldDef.regex && value) {
    const match = value.match(new RegExp(fieldDef.regex));
    value = match ? match[1] || match[0] : '';
  }

  // Apply transform
  switch (fieldDef.transform) {
    case 'number': {
      const num = parseFloat(value.replace(/[^0-9.-]/g, ''));
      return Number.isNaN(num) ? null : num;
    }
    case 'date': {
      // Return ISO string if parseable
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date.toISOString();
    }
    case 'html':
      return target.innerHTML?.trim() || null;
    default:
      return value || null;
  }
}

/**
 * Generate a unique ID for an extracted item
 */
function generateItemId(item: Record<string, unknown>, index: number): string {
  // Use date + author if available, otherwise use index
  const date = item.published_at || item.date;
  const author = item.author;

  if (date && author) {
    return `${date}-${author}`.replace(/[^a-zA-Z0-9-]/g, '-');
  }

  // Fallback to content hash
  const content = String(item.content || item.text || '');
  const hash = content.slice(0, 50).replace(/[^a-zA-Z0-9]/g, '');
  return `item-${index}-${hash}`;
}

/**
 * Extract items from the current page using the provided config
 */
export function extractFromPage(config: ExtractorConfig): ExtractionResult {
  console.log(`[Owletto] Extracting with config for ${config.platform} v${config.version}`);

  try {
    const containers = document.querySelectorAll(config.selectors.container);
    console.log(`[Owletto] Found ${containers.length} containers`);

    if (containers.length === 0) {
      return {
        success: false,
        items: [],
        hasNextPage: false,
        error: `No elements found for container: ${config.selectors.container}`,
      };
    }

    const items: ExtractedItem[] = [];

    containers.forEach((container, index) => {
      const rawItem: Record<string, unknown> = {};

      // Extract each field
      for (const [fieldName, fieldDef] of Object.entries(config.selectors.fields)) {
        const value = extractField(container, fieldDef);
        if (value !== null) {
          rawItem[fieldName] = value;
        }
      }

      // Skip if no content extracted
      if (!rawItem.content && !rawItem.text && !rawItem.title) {
        console.log(`[Owletto] Skipping empty item at index ${index}`);
        return;
      }

      // Build the extracted item
      const item: ExtractedItem = {
        id: generateItemId(rawItem, index),
        content: String(rawItem.content || rawItem.text || ''),
        url: window.location.href,
        metadata: {},
      };

      // Map known fields
      if (rawItem.title) item.title = String(rawItem.title);
      if (rawItem.author) item.author = String(rawItem.author);
      if (rawItem.date || rawItem.published_at) {
        item.published_at = String(rawItem.date || rawItem.published_at);
      }

      // Put remaining fields in metadata
      for (const [key, value] of Object.entries(rawItem)) {
        if (!['content', 'text', 'title', 'author', 'date', 'published_at'].includes(key)) {
          item.metadata[key] = value;
        }
      }

      items.push(item);
    });

    console.log(`[Owletto] Extracted ${items.length} items`);

    // Check for next page
    const { hasNextPage, nextPageUrl } = checkPagination(config);

    return {
      success: true,
      items,
      hasNextPage,
      nextPageUrl,
    };
  } catch (error) {
    console.error('[Owletto] Extraction error:', error);
    return {
      success: false,
      items: [],
      hasNextPage: false,
      error: error instanceof Error ? error.message : 'Unknown extraction error',
    };
  }
}

/**
 * Check if there's a next page based on pagination config
 */
function checkPagination(config: ExtractorConfig): { hasNextPage: boolean; nextPageUrl?: string } {
  const pagination = config.selectors.pagination;

  if (!pagination) {
    return { hasNextPage: false };
  }

  switch (pagination.type) {
    case 'url_param': {
      // Check current page from URL
      const url = new URL(window.location.href);
      const currentPage = parseInt(
        url.searchParams.get(pagination.page_param || 'page') || '1',
        10
      );
      const nextPage = currentPage + 1;

      // Look for indicators that more pages exist
      // Check if there's a "next" link or if current page has items
      const hasItems = document.querySelectorAll(config.selectors.container).length > 0;

      if (hasItems) {
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set(pagination.page_param || 'page', String(nextPage));
        return { hasNextPage: true, nextPageUrl: nextUrl.toString() };
      }
      return { hasNextPage: false };
    }

    case 'cursor': {
      // Check for next button
      if (pagination.next_button) {
        const nextButton = document.querySelector(pagination.next_button);
        if (nextButton && !nextButton.hasAttribute('disabled')) {
          return { hasNextPage: true };
        }
      }
      return { hasNextPage: false };
    }

    case 'infinite_scroll': {
      // Infinite scroll pagination - always has potentially more
      return { hasNextPage: true };
    }

    default:
      return { hasNextPage: false };
  }
}

/**
 * Scroll to load more content (for infinite scroll pagination)
 */
export async function scrollForMore(
  config: ExtractorConfig,
  maxScrolls: number = 3
): Promise<number> {
  const pagination = config.selectors.pagination;
  if (pagination?.type !== 'infinite_scroll') {
    return 0;
  }

  const scrollContainer = pagination.scroll_container
    ? document.querySelector(pagination.scroll_container)
    : window;

  let scrollCount = 0;
  const initialCount = document.querySelectorAll(config.selectors.container).length;

  for (let i = 0; i < maxScrolls; i++) {
    // Scroll down
    if (scrollContainer === window) {
      window.scrollTo(0, document.body.scrollHeight);
    } else if (scrollContainer) {
      (scrollContainer as HTMLElement).scrollTop = (scrollContainer as HTMLElement).scrollHeight;
    }

    scrollCount++;

    // Wait for content to load
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Check if new content loaded
    const newCount = document.querySelectorAll(config.selectors.container).length;
    if (newCount === initialCount) {
      // No new content, stop scrolling
      break;
    }
  }

  return scrollCount;
}
