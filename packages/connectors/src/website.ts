/**
 * Website Connector
 *
 * Scrapes web pages using Playwright for JS rendering.
 * Supports sitemap.xml discovery or explicit URL list.
 * Converts HTML → Markdown, splits into hierarchical sections.
 * Tracks changes between syncs via content hashing.
 */

import { createHash } from 'node:crypto';
import TurndownService from 'npm:turndown@7.2.2';
import {
  type ActionContext,
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  launchBrowser,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';
import type { Page } from 'playwright';

interface PageSection {
  heading: string;
  level: number;
  content: string;
  anchor: string;
}

const COOKIE_BANNER_PATTERNS = [
  /\bcookie(s)?\b/i,
  /\bconsent\b/i,
  /\baccept all\b/i,
  /\breject all\b/i,
  /\bmanage (my )?preferences\b/i,
  /\bprivacy preferences\b/i,
  /\bmarketing\b/i,
  /\bmeasurement\b/i,
  /\bnecessary\b/i,
];

function countPatternMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function shouldSkipCookieBannerText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return countPatternMatches(normalized, COOKIE_BANNER_PATTERNS) >= 3;
}

/**
 * Validates a URL is safe for server-side fetching.
 * Blocks private/internal network addresses to prevent SSRF attacks.
 */
function validatePublicUrl(url: string): void {
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

  // Block private/internal IP ranges
  // IPv4 patterns: 127.x.x.x, 10.x.x.x, 192.168.x.x, 172.16-31.x.x, 169.254.x.x, 0.x.x.x
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (
      a === 127 || // 127.0.0.0/8 loopback
      a === 10 || // 10.0.0.0/8 private
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
      (a === 192 && b === 168) || // 192.168.0.0/16 private
      (a === 169 && b === 254) || // 169.254.0.0/16 link-local
      a === 0 // 0.0.0.0/8
    ) {
      throw new Error(`URL must not point to a private/internal IP address: ${hostname}`);
    }
  }

  // Block IPv6 private ranges (bracketed notation in URLs)
  if (hostname.startsWith('[')) {
    const ipv6 = hostname.slice(1, -1).toLowerCase();
    if (
      ipv6 === '::1' ||
      ipv6.startsWith('fe80:') || // link-local
      ipv6.startsWith('fc') || // unique local (fc00::/7)
      ipv6.startsWith('fd') || // unique local (fc00::/7)
      ipv6 === '::' || // unspecified
      ipv6.startsWith('::ffff:') // IPv4-mapped IPv6
    ) {
      throw new Error(`URL must not point to a private/internal IPv6 address: ${hostname}`);
    }
  }

  // Block common internal hostnames
  if (
    hostname.endsWith('.internal') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.corp') ||
    hostname.endsWith('.lan')
  ) {
    throw new Error(`URL must not point to an internal hostname: ${hostname}`);
  }
}

export default class WebsiteConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'website',
    name: 'Website',
    description:
      'Scrapes web pages with JS rendering via Playwright. Supports sitemap.xml for auto-discovery. Converts to markdown sections and tracks changes.',
    version: '1.0.0',
    faviconDomain: 'google.com',
    authSchema: {
      methods: [{ type: 'none' }],
    },
    feeds: {
      pages: {
        key: 'pages',
        name: 'Web Pages',
        description: 'Scrape and parse web pages into structured content.',
        configSchema: {
          type: 'object',
          properties: {
            sitemap_url: {
              type: 'string',
              format: 'uri',
              description:
                'URL to sitemap.xml. All URLs from the sitemap will be scraped. Takes priority over urls.',
            },
            urls: {
              type: 'array',
              items: { type: 'string', format: 'uri' },
              description: 'Explicit list of URLs to scrape. Ignored if sitemap_url is set.',
            },
            max_pages: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              default: 20,
              description: 'Maximum number of pages to scrape per sync (default: 20)',
            },
            parse_sections: {
              type: 'boolean',
              default: true,
              description:
                'Split page into sections by headings (h1-h3). If false, one event per page.',
            },
            wait_for_selector: {
              type: 'string',
              description:
                'CSS selector to wait for before extracting content (e.g. "main", "#content"). Useful for SPAs.',
            },
          },
        },
        eventKinds: {
          page: {
            description: 'Full page content',
            metadataSchema: {
              type: 'object',
              properties: {
                content_hash: { type: 'string' },
                meta_title: { type: 'string' },
                meta_description: { type: 'string' },
                og_image: { type: 'string' },
                word_count: { type: 'number' },
              },
            },
          },
          section: {
            description: 'A section of a page (split by headings)',
            metadataSchema: {
              type: 'object',
              properties: {
                heading: { type: 'string' },
                heading_level: { type: 'number' },
                anchor: { type: 'string' },
                section_index: { type: 'number' },
                page_url: { type: 'string' },
                content_hash: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };

  private turndown: TurndownService;
  private readonly PAGE_TIMEOUT = 30000;
  private readonly PAGE_DELAY_MS = 2000;

  constructor() {
    super();
    this.turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
    });
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const sitemapUrl = ctx.config.sitemap_url as string | undefined;
    const explicitUrls = ctx.config.urls as string[] | undefined;
    const maxPages = (ctx.config.max_pages as number) ?? 20;
    const parseSections = (ctx.config.parse_sections as boolean) ?? true;
    const waitForSelector = ctx.config.wait_for_selector as string | undefined;
    const previousHashes = (ctx.checkpoint?.hashes as Record<string, string>) ?? {};

    // Resolve URLs from sitemap or explicit list
    let urls: string[];
    if (sitemapUrl) {
      validatePublicUrl(sitemapUrl);
      urls = await this.fetchSitemap(sitemapUrl);
      ctx.log?.(`Sitemap: found ${urls.length} URLs`);
    } else if (explicitUrls?.length) {
      urls = explicitUrls;
    } else {
      return {
        events: [],
        checkpoint: ctx.checkpoint,
        metadata: { error: 'No sitemap_url or urls configured' },
      };
    }

    urls = urls.slice(0, maxPages);

    // Launch browser
    const { browser } = await launchBrowser({} as any, { stealth: false });
    const events: EventEnvelope[] = [];
    const newHashes: Record<string, string> = {};

    try {
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        try {
          validatePublicUrl(url);
          const page = (await browser.newPage()) as Page;
          try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: this.PAGE_TIMEOUT });
            await this.dismissOverlays(page);

            if (waitForSelector) {
              await page.waitForSelector(waitForSelector, { timeout: 10000 }).catch(() => {
                ctx.log?.(`Selector "${waitForSelector}" not found on ${url}, continuing anyway`);
              });
            }

            await this.removeHiddenElements(page);
            const html = await page.content();
            const finalUrl = page.url();
            const meta = this.extractMeta(html);
            const cleanHtml = this.stripNonContent(html);
            const markdown = this.deduplicateMarkdown(this.turndown.turndown(cleanHtml).trim());
            if (!markdown || shouldSkipCookieBannerText(`${meta.title ?? ''}\n${markdown}`)) {
              ctx.log?.(`Skipping low-signal page content for ${finalUrl}`);
              continue;
            }
            const contentHash = this.hash(markdown);

            if (previousHashes[url] === contentHash) {
              newHashes[url] = contentHash;
              continue;
            }
            newHashes[url] = contentHash;

            if (parseSections) {
              const sections = this.parseSections(markdown);
              for (let si = 0; si < sections.length; si++) {
                const section = sections[si];
                const sectionHash = this.hash(section.content);
                const sectionKey = `${url}#${section.anchor}`;

                if (previousHashes[sectionKey] === sectionHash) {
                  newHashes[sectionKey] = sectionHash;
                  continue;
                }
                newHashes[sectionKey] = sectionHash;
                if (shouldSkipCookieBannerText(`${section.heading}\n${section.content}`)) {
                  continue;
                }

                const parentKey = section.parentAnchor
                  ? `${url}#${section.parentAnchor}`
                  : undefined;
                events.push({
                  origin_id: `web_section_${this.hash(sectionKey)}`,
                  title: section.heading,
                  payload_text: section.content,
                  source_url: `${finalUrl}#${section.anchor}`,
                  occurred_at: new Date(),
                  origin_type: 'section',
                  semantic_type: 'section',
                  score: 50,
                  origin_parent_id: parentKey ? `web_section_${this.hash(parentKey)}` : undefined,
                  metadata: {
                    heading: section.heading,
                    heading_level: section.level,
                    anchor: section.anchor,
                    section_index: si,
                    page_url: finalUrl,
                    content_hash: sectionHash,
                  },
                });
              }
            } else {
              events.push({
                origin_id: `web_page_${this.hash(url)}`,
                title: meta.title || finalUrl,
                payload_text: markdown,
                source_url: finalUrl,
                occurred_at: new Date(),
                origin_type: 'page',
                semantic_type: 'page',
                score: 50,
                metadata: {
                  content_hash: contentHash,
                  meta_title: meta.title,
                  meta_description: meta.description,
                  og_image: meta.ogImage,
                  word_count: markdown.split(/\s+/).length,
                },
              });
            }
          } finally {
            await page.close();
          }
        } catch (err) {
          ctx.log?.(`Failed to scrape ${url}: ${err instanceof Error ? err.message : String(err)}`);
        }

        if (i < urls.length - 1) {
          await this.sleep(this.PAGE_DELAY_MS);
        }
      }
    } finally {
      await browser.close();
    }

    return {
      events,
      checkpoint: { hashes: newHashes, last_sync_at: new Date().toISOString() },
      metadata: { pages_scraped: urls.length, events_created: events.length },
    };
  }

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: 'Actions not supported' };
  }

  private async dismissOverlays(page: Page): Promise<void> {
    const dismissLabels = [
      'Accept',
      'Accept all',
      'I agree',
      'Allow all',
      'Got it',
      'Continue',
      'Close',
    ];

    for (const label of dismissLabels) {
      try {
        const button = page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).first();
        if (await button.isVisible({ timeout: 500 })) {
          await button.click({ timeout: 1000 });
          break;
        }
      } catch {
        // Keep trying other labels/selectors.
      }
    }

    await page
      .evaluate(() => {
        const selectors = [
          '[id*="cookie" i]',
          '[class*="cookie" i]',
          '[id*="consent" i]',
          '[class*="consent" i]',
          '[id*="onetrust" i]',
          '[class*="onetrust" i]',
          '[aria-modal="true"]',
          '[role="dialog"]',
        ];

        for (const element of document.querySelectorAll(selectors.join(','))) {
          const html = (element as HTMLElement).innerText || '';
          if (/cookie|consent|privacy/i.test(html)) {
            element.remove();
          }
        }
      })
      .catch(() => {
        // DOM cleanup is best-effort.
      });
  }

  /**
   * Remove DOM elements hidden via CSS (display:none, visibility:hidden, zero dimensions).
   * This handles responsive duplicates where the same content is rendered for
   * desktop and mobile with Tailwind classes like `hidden md:block` / `md:hidden`.
   */
  private async removeHiddenElements(page: Page): Promise<void> {
    await page
      .evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        const toRemove: Element[] = [];
        while (walker.nextNode()) {
          const el = walker.currentNode as HTMLElement;
          // Skip elements that can't meaningfully contain scraped content
          if (['SCRIPT', 'STYLE', 'LINK', 'META', 'BR', 'HR'].includes(el.tagName)) continue;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') {
            toRemove.push(el);
          }
        }
        for (const el of toRemove) {
          el.remove();
        }
      })
      .catch(() => {
        // Best-effort — continue with the full DOM if this fails.
      });
  }

  /**
   * Deduplicate repeated lines in markdown output.
   * Animation containers and responsive layouts often produce identical image
   * or link lines multiple times. This keeps the first occurrence of each.
   */
  private deduplicateMarkdown(markdown: string): string {
    const lines = markdown.split('\n');
    const seen = new Set<string>();
    const result: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      // Only dedup substantial lines (short lines like blank lines or list markers are fine to repeat)
      if (trimmed.length >= 80) {
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
      }
      result.push(line);
    }
    return result.join('\n');
  }

  private async fetchSitemap(sitemapUrl: string): Promise<string[]> {
    const response = await fetch(sitemapUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OwlettoBot/1.0)' },
    });

    if (!response.ok) {
      throw new Error(`Sitemap fetch failed: HTTP ${response.status}`);
    }

    const xml = await response.text();
    const urls: string[] = [];

    // Parse <loc> tags from sitemap XML
    const locPattern = /<loc>\s*(.*?)\s*<\/loc>/gi;
    let match;
    while ((match = locPattern.exec(xml)) !== null) {
      const url = match[1].trim();
      // Skip non-HTML resources and anchor fragment URLs
      if (
        url &&
        !url.match(/\.(pdf|jpg|jpeg|png|gif|svg|css|js|xml|json|zip|gz)$/i) &&
        !url.includes('#')
      ) {
        urls.push(url);
      }
    }

    // Handle sitemap index (sitemaps linking to other sitemaps)
    if (urls.length === 0) {
      const sitemapPattern = /<sitemap>\s*<loc>\s*(.*?)\s*<\/loc>/gi;
      const childSitemaps: string[] = [];
      while ((match = sitemapPattern.exec(xml)) !== null) {
        childSitemaps.push(match[1].trim());
      }
      for (const childUrl of childSitemaps.slice(0, 5)) {
        validatePublicUrl(childUrl);
        const childUrls = await this.fetchSitemap(childUrl);
        urls.push(...childUrls);
      }
    }

    return urls;
  }

  private extractMeta(html: string): { title?: string; description?: string; ogImage?: string } {
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
    const descMatch =
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
    const ogMatch =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);

    return {
      title: titleMatch?.[1]?.trim(),
      description: descMatch?.[1]?.trim(),
      ogImage: ogMatch?.[1]?.trim(),
    };
  }

  private stripNonContent(html: string): string {
    const tags = [
      'script',
      'style',
      'noscript',
      'nav',
      'header',
      'footer',
      'aside',
      'iframe',
      'svg',
      'canvas',
      'video',
      'audio',
      'menu',
      'dialog',
      'embed',
      'object',
      'applet',
    ];
    let cleaned = html;
    for (const tag of tags) {
      cleaned = cleaned.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
    }
    // Remove self-closing / void elements that add noise
    cleaned = cleaned.replace(/<(link|meta|input)\b[^>]*\/?>/gi, '');
    return cleaned;
  }

  private parseSections(markdown: string): (PageSection & { parentAnchor?: string })[] {
    const lines = markdown.split('\n');
    const sections: (PageSection & { parentAnchor?: string })[] = [];
    let currentHeading = 'Introduction';
    let currentLevel = 1;
    let currentLines: string[] = [];

    // Per-slug counters so anchors stay stable when unrelated sections change.
    // Only incremented when a section is emitted, not for heading stack entries.
    const slugCounts = new Map<string, number>();

    const makeAnchor = (heading: string): string => {
      const slug = this.slugify(heading);
      const count = slugCounts.get(slug) ?? 0;
      slugCounts.set(slug, count + 1);
      return count === 0 ? slug : `${slug}-${count}`;
    };

    // Track parent heading stack for hierarchy.
    // Anchors are assigned lazily when the heading's section is emitted.
    const headingStack: { heading: string; level: number; anchor?: string }[] = [];

    const emitSection = (heading: string, level: number, content: string) => {
      const anchor = makeAnchor(heading);
      // Update the heading stack entry for this heading so children can reference it
      const stackEntry = headingStack.find((e) => e.heading === heading && e.anchor === undefined);
      if (stackEntry) stackEntry.anchor = anchor;
      const parent = headingStack.length > 0 ? headingStack[headingStack.length - 1] : undefined;
      const parentAnchor = parent?.heading === heading ? undefined : parent?.anchor;
      sections.push({ heading, level, content, anchor, parentAnchor });
    };

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
      if (headingMatch) {
        const content = currentLines.join('\n').trim();
        if (content.length > 0) {
          emitSection(currentHeading, currentLevel, content);
        }

        const newLevel = headingMatch[1].length;
        const newHeading = headingMatch[2].trim();

        // Pop stack until we find a parent with a lower level
        while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= newLevel) {
          headingStack.pop();
        }
        headingStack.push({ heading: newHeading, level: newLevel });

        currentHeading = newHeading;
        currentLevel = newLevel;
        currentLines = [];
      } else {
        currentLines.push(line);
      }
    }

    const content = currentLines.join('\n').trim();
    if (content.length > 0) {
      emitSection(currentHeading, currentLevel, content);
    }

    return sections;
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 60);
  }

  private hash(text: string): string {
    return createHash('sha256').update(text).digest('hex').substring(0, 16);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
