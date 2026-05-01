/**
 * RSS / Atom Connector (V1 runtime)
 *
 * Fetches and parses RSS 2.0 and Atom feeds. Supports multiple feed URLs,
 * deduplication via checkpoint, and HTML entity decoding.
 * No external XML parsing dependencies — uses regex-based parsing.
 */

import {
  type ActionContext,
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RSSFeedItem {
  id: string;
  title: string;
  link: string;
  content: string;
  author: string;
  publishedAt: Date;
  feedUrl: string;
}

interface RSSCheckpoint {
  last_item_ids: string[];
  last_published_at?: string;
}

interface RSSConfig {
  feed_urls: string[];
  max_items_per_feed?: number;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class RSSConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'rss',
    name: 'RSS / Atom',
    description: 'Fetches and parses RSS 2.0 and Atom feeds to collect articles.',
    version: '1.0.0',
    faviconDomain: 'rss.com',
    authSchema: {
      methods: [{ type: 'none' }],
    },
    feeds: {
      articles: {
        key: 'articles',
        name: 'Feed Articles',
        description: 'Articles from RSS/Atom feeds.',
        configSchema: {
          type: 'object',
          required: ['feed_urls'],
          properties: {
            feed_urls: {
              type: 'array',
              items: { type: 'string', format: 'uri' },
              minItems: 1,
              description: 'One or more RSS/Atom feed URLs.',
            },
            max_items_per_feed: {
              type: 'integer',
              minimum: 1,
              maximum: 1000,
              default: 100,
              description: 'Maximum items to collect per feed per sync.',
            },
          },
        },
        eventKinds: {
          article: {
            description: 'A blog post or article from an RSS/Atom feed',
            metadataSchema: {
              type: 'object',
              properties: {
                feed_url: {
                  type: 'string',
                  format: 'uri',
                  description: 'The feed URL this article came from',
                },
              },
            },
          },
        },
      },
    },
    optionsSchema: {
      type: 'object',
      required: ['feed_urls'],
      properties: {
        feed_urls: {
          type: 'array',
          items: { type: 'string', format: 'uri' },
          minItems: 1,
          description: 'One or more RSS/Atom feed URLs.',
        },
        max_items_per_feed: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          default: 100,
          description: 'Maximum items to collect per feed per sync.',
        },
      },
    },
  };

  private readonly MAX_DEDUP_IDS = 500;
  private readonly FETCH_TIMEOUT_MS = 15000;
  private readonly USER_AGENT = 'Owletto-RSS-Connector/1.0.0';

  // -------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const config = ctx.config as unknown as RSSConfig;
    const feedUrls = config.feed_urls;
    if (!feedUrls || !Array.isArray(feedUrls) || feedUrls.length === 0) {
      throw new Error('feed_urls is required and must be a non-empty array.');
    }

    const maxItemsPerFeed = config.max_items_per_feed ?? 100;
    const checkpoint = (ctx.checkpoint as RSSCheckpoint | null) ?? {
      last_item_ids: [],
    };
    const seenIds = new Set<string>(checkpoint.last_item_ids ?? []);

    const allItems: RSSFeedItem[] = [];

    for (const feedUrl of feedUrls) {
      try {
        const items = await this.fetchAndParseFeed(feedUrl, maxItemsPerFeed);
        allItems.push(...items);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`Failed to fetch feed ${feedUrl}: ${message}`);
      }
    }

    // Sort by occurred_at descending
    allItems.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

    // Deduplicate against checkpoint
    const events: EventEnvelope[] = [];
    const newIds: string[] = [];

    for (const item of allItems) {
      if (seenIds.has(item.id)) continue;

      seenIds.add(item.id);
      newIds.push(item.id);

      events.push({
        origin_id: item.id,
        title: item.title,
        payload_text: item.content,
        author_name: item.author || undefined,
        source_url: item.link || undefined,
        occurred_at: item.publishedAt,
        origin_type: 'article',
        metadata: {
          feed_url: item.feedUrl,
        },
      });
    }

    // Build updated checkpoint — keep last N IDs for dedup
    const allKnownIds = [...(checkpoint.last_item_ids ?? []), ...newIds];
    const trimmedIds = allKnownIds.slice(-this.MAX_DEDUP_IDS);

    const latestPublishedAt =
      events.length > 0 ? events[0].occurred_at.toISOString() : checkpoint.last_published_at;

    const newCheckpoint: RSSCheckpoint = {
      last_item_ids: trimmedIds,
      last_published_at: latestPublishedAt,
    };

    return {
      events,
      checkpoint: newCheckpoint as unknown as Record<string, unknown>,
      metadata: {
        items_found: events.length,
        feeds_fetched: feedUrls.length,
      },
    };
  }

  // -------------------------------------------------------------------------
  // execute
  // -------------------------------------------------------------------------

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: 'Actions not supported' };
  }

  // -------------------------------------------------------------------------
  // Feed fetching & parsing
  // -------------------------------------------------------------------------

  private async fetchAndParseFeed(feedUrl: string, maxItems: number): Promise<RSSFeedItem[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(feedUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': this.USER_AGENT,
          Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const xml = await response.text();
      return this.parseXml(xml, feedUrl, maxItems);
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  private parseXml(xml: string, feedUrl: string, maxItems: number): RSSFeedItem[] {
    // Detect Atom vs RSS
    if (this.isAtomFeed(xml)) {
      return this.parseAtom(xml, feedUrl, maxItems);
    }
    return this.parseRSS(xml, feedUrl, maxItems);
  }

  private isAtomFeed(xml: string): boolean {
    // Atom feeds have <feed xmlns="http://www.w3.org/2005/Atom"> or just <feed>
    return /<feed[\s>]/.test(xml) && !/<rss[\s>]/.test(xml);
  }

  // -------------------------------------------------------------------------
  // RSS 2.0 parser
  // -------------------------------------------------------------------------

  private parseRSS(xml: string, feedUrl: string, maxItems: number): RSSFeedItem[] {
    const items: RSSFeedItem[] = [];
    const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
    let match: RegExpExecArray | null;

    while ((match = itemRegex.exec(xml)) !== null && items.length < maxItems) {
      const block = match[1];

      const title = this.extractTag(block, 'title');
      const link = this.extractTag(block, 'link');
      const description = this.extractTag(block, 'description');
      const contentEncoded =
        this.extractCDataTag(block, 'content:encoded') ?? this.extractTag(block, 'content:encoded');
      const pubDate = this.extractTag(block, 'pubDate');
      const guid = this.extractTag(block, 'guid');
      const author = this.extractTag(block, 'author') ?? this.extractTag(block, 'dc:creator') ?? '';

      const id = guid || this.hashString(`${title ?? ''}|${link ?? ''}`);
      const content = contentEncoded || description || '';

      const publishedAt = pubDate ? this.parseDate(pubDate) : new Date();

      items.push({
        id,
        title: this.decodeEntities(this.stripHtml(title ?? '')),
        link: this.decodeEntities(link ?? ''),
        content: this.decodeEntities(this.stripHtml(content)),
        author: this.decodeEntities(this.stripHtml(author)),
        publishedAt,
        feedUrl,
      });
    }

    return items;
  }

  // -------------------------------------------------------------------------
  // Atom parser
  // -------------------------------------------------------------------------

  private parseAtom(xml: string, feedUrl: string, maxItems: number): RSSFeedItem[] {
    const items: RSSFeedItem[] = [];
    const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
    let match: RegExpExecArray | null;

    while ((match = entryRegex.exec(xml)) !== null && items.length < maxItems) {
      const block = match[1];

      const title = this.extractTag(block, 'title');
      const link = this.extractAtomLink(block);
      const content = this.extractTag(block, 'content') ?? this.extractTag(block, 'summary') ?? '';
      const published =
        this.extractTag(block, 'published') ?? this.extractTag(block, 'updated') ?? '';
      const id = this.extractTag(block, 'id');
      const author = this.extractAtomAuthor(block);

      const externalId = id || this.hashString(`${title ?? ''}|${link ?? ''}`);
      const publishedAt = published ? this.parseDate(published) : new Date();

      items.push({
        id: externalId,
        title: this.decodeEntities(this.stripHtml(title ?? '')),
        link: this.decodeEntities(link ?? ''),
        content: this.decodeEntities(this.stripHtml(content)),
        author: this.decodeEntities(this.stripHtml(author)),
        publishedAt,
        feedUrl,
      });
    }

    return items;
  }

  // -------------------------------------------------------------------------
  // XML extraction helpers
  // -------------------------------------------------------------------------

  /** Extract text content from an XML tag. Handles CDATA and regular text. */
  private extractTag(block: string, tagName: string): string | null {
    // Try CDATA first
    const cdataResult = this.extractCDataTag(block, tagName);
    if (cdataResult !== null) return cdataResult;

    // Regular tag content — handle self-closing tags and tags with attributes
    const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i');
    const match = regex.exec(block);
    return match ? match[1].trim() : null;
  }

  /** Extract CDATA content from an XML tag. */
  private extractCDataTag(block: string, tagName: string): string | null {
    const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(
      `<${escaped}(?:\\s[^>]*)?>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${escaped}>`,
      'i'
    );
    const match = regex.exec(block);
    return match ? match[1].trim() : null;
  }

  /** Extract href from Atom <link> element. */
  private extractAtomLink(block: string): string | null {
    // Try <link rel="alternate" href="..."> first
    const alternateMatch =
      /<link[^>]*rel\s*=\s*["']alternate["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*\/?>/i.exec(block);
    if (alternateMatch) return alternateMatch[1];

    // Also check href before rel
    const alternateMatch2 =
      /<link[^>]*href\s*=\s*["']([^"']+)["'][^>]*rel\s*=\s*["']alternate["'][^>]*\/?>/i.exec(block);
    if (alternateMatch2) return alternateMatch2[1];

    // Fall back to any <link href="..."> (not rel="self" or rel="enclosure")
    const linkRegex = /<link[^>]*href\s*=\s*["']([^"']+)["'][^>]*\/?>/gi;
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(block)) !== null) {
      const full = match[0];
      if (/rel\s*=\s*["']self["']/i.test(full)) continue;
      if (/rel\s*=\s*["']enclosure["']/i.test(full)) continue;
      return match[1];
    }

    return null;
  }

  /** Extract author name from Atom <author><name>...</name></author>. */
  private extractAtomAuthor(block: string): string {
    const authorMatch = /<author[\s>]([\s\S]*?)<\/author>/i.exec(block);
    if (!authorMatch) return '';
    const nameMatch = /<name>([\s\S]*?)<\/name>/i.exec(authorMatch[1]);
    return nameMatch ? nameMatch[1].trim() : '';
  }

  // -------------------------------------------------------------------------
  // String helpers
  // -------------------------------------------------------------------------

  /**
   * Decode common HTML entities in a single pass so chained entities like
   * '&amp;lt;' are not double-unescaped into '<'.
   */
  private decodeEntities(text: string): string {
    return text.replace(
      /&(amp|lt|gt|quot|apos|#39|#x([0-9a-fA-F]+)|#(\d+));/g,
      (_match, name, hex, decimal) => {
        switch (name) {
          case 'amp':
            return '&';
          case 'lt':
            return '<';
          case 'gt':
            return '>';
          case 'quot':
            return '"';
          case 'apos':
          case '#39':
            return "'";
          default:
            if (hex) return String.fromCharCode(parseInt(hex, 16));
            if (decimal) return String.fromCharCode(parseInt(decimal, 10));
            return _match;
        }
      }
    );
  }

  /** Strip HTML tags from text. */
  private stripHtml(text: string): string {
    return text
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Parse a date string, falling back to current time. */
  private parseDate(dateStr: string): Date {
    const parsed = new Date(dateStr);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  /** Simple hash of a string, returned as a hex string. */
  private hashString(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0; // Convert to 32-bit integer
    }
    return `rss_${Math.abs(hash).toString(16)}`;
  }
}
