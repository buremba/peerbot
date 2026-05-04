/**
 * HackerNews Connector (V1 runtime)
 *
 * Searches Hacker News stories and comments via the Algolia HN Search API.
 * No authentication required.
 */

import TurndownService from 'turndown';
import {
  type ActionContext,
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  calculateEngagementScore,
  type EventEnvelope,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

// ---------------------------------------------------------------------------
// Algolia HN API types
// ---------------------------------------------------------------------------

interface AlgoliaHit {
  objectID: string;
  created_at: string;
  created_at_i: number;
  author: string;
  title?: string;
  story_text?: string;
  comment_text?: string;
  url?: string;
  points?: number;
  num_comments?: number;
  story_id?: number;
  parent_id?: number;
  _tags: string[];
}

interface AlgoliaResponse {
  hits: AlgoliaHit[];
  nbHits: number;
  page: number;
  nbPages: number;
  hitsPerPage: number;
}

// ---------------------------------------------------------------------------
// Content-type tag mapping
// ---------------------------------------------------------------------------

const CONTENT_TYPE_TAG: Record<string, string> = {
  story: 'story',
  comment: 'comment',
  ask_hn: 'ask_hn',
  show_hn: 'show_hn',
};

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class HackerNewsConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'hackernews',
    name: 'Hacker News',
    description: 'Searches Hacker News stories and comments via Algolia API.',
    version: '1.0.0',
    faviconDomain: 'news.ycombinator.com',
    authSchema: {
      methods: [{ type: 'none' }],
    },
    feeds: {
      stories: {
        key: 'stories',
        name: 'Stories',
        description: 'Search HN for stories, Ask HN, and Show HN posts.',
        configSchema: {
          type: 'object',
          required: ['search_query'],
          properties: {
            search_query: {
              type: 'string',
              minLength: 1,
              description: 'Search term',
            },
            story_type: {
              type: 'string',
              enum: ['story', 'ask_hn', 'show_hn'],
              default: 'story',
              description: 'Story type filter',
            },
            lookback_days: {
              type: 'integer',
              minimum: 1,
              maximum: 730,
              default: 365,
              description: 'Lookback window in days',
            },
            search_fields: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['title', 'url', 'story_text'],
              },
              default: ['title'],
              description:
                'Algolia fields to search in. Defaults to title only. Add url and/or story_text for broader matching (may increase noise for common words like "notion" or "linear").',
            },
          },
        },
        eventKinds: {
          story: {
            description: 'A Hacker News story',
            metadataSchema: {
              type: 'object',
              properties: {
                story_type: { type: 'string', description: 'story, ask_hn, or show_hn' },
                tags: { type: 'array', items: { type: 'string' } },
                external_url: { type: 'string', format: 'uri' },
                score: { type: 'number', description: 'HN points' },
                reply_count: { type: 'number' },
              },
            },
          },
          ask_hn: {
            description: 'An Ask HN post',
            metadataSchema: {
              type: 'object',
              properties: {
                story_type: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                score: { type: 'number' },
                reply_count: { type: 'number' },
              },
            },
          },
          show_hn: {
            description: 'A Show HN post',
            metadataSchema: {
              type: 'object',
              properties: {
                story_type: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                external_url: { type: 'string', format: 'uri' },
                score: { type: 'number' },
                reply_count: { type: 'number' },
              },
            },
          },
        },
      },
      comments: {
        key: 'comments',
        name: 'Comments',
        description: 'Search HN for comments.',
        configSchema: {
          type: 'object',
          required: ['search_query'],
          properties: {
            search_query: {
              type: 'string',
              minLength: 1,
              description: 'Search term',
            },
            lookback_days: {
              type: 'integer',
              minimum: 1,
              maximum: 730,
              default: 365,
              description: 'Lookback window in days',
            },
            search_fields: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['comment_text', 'author'],
              },
              default: ['comment_text'],
              description: 'Algolia fields to search in. Defaults to comment_text.',
            },
          },
        },
        eventKinds: {
          comment: {
            description: 'A Hacker News comment',
            metadataSchema: {
              type: 'object',
              properties: {
                story_id: { type: 'number' },
                parent_id: { type: 'number' },
                tags: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    optionsSchema: {
      type: 'object',
      required: ['search_query'],
      properties: {
        search_query: {
          type: 'string',
          minLength: 1,
          description: 'Search term',
        },
        lookback_days: {
          type: 'integer',
          minimum: 1,
          maximum: 730,
          default: 365,
          description: 'Lookback window in days',
        },
      },
    },
  };

  private readonly BASE_URL = 'https://hn.algolia.com/api/v1';
  private readonly ENGAGEMENT_THRESHOLD = 50;
  private readonly CONTENT_FETCH_TIMEOUT = 5000;
  private readonly MAX_PAGES = 50;
  private readonly PAGE_DELAY_MS = 1000;
  private readonly FETCH_DELAY_MS = 2000;
  private turndownService: TurndownService;

  constructor() {
    super();
    this.turndownService = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
    });
  }

  // -------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const searchQuery = ctx.config.search_query as string;
    const contentType =
      ctx.feedKey === 'comments' ? 'comment' : ((ctx.config.story_type as string) ?? 'story');
    const lookbackDays = (ctx.config.lookback_days as number) ?? 365;
    const searchFields =
      (ctx.config.search_fields as string[] | undefined) ??
      (contentType === 'comment' ? ['comment_text'] : ['title']);

    const lookbackTimestamp = Math.floor((Date.now() - lookbackDays * 86400000) / 1000);
    const tag = CONTENT_TYPE_TAG[contentType] ?? 'story';

    const events: EventEnvelope[] = [];
    let page = 0;
    let hasMore = true;

    while (hasMore && page < this.MAX_PAGES) {
      const url =
        `${this.BASE_URL}/search?query=${encodeURIComponent(searchQuery)}` +
        `&tags=${tag}&hitsPerPage=100&page=${page}` +
        '&typoTolerance=false' +
        `&restrictSearchableAttributes=${encodeURIComponent(searchFields.join(','))}` +
        `&numericFilters=${encodeURIComponent(`created_at_i>${lookbackTimestamp}`)}`;

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Algolia API error (${response.status}): ${await response.text()}`);
      }

      const data = (await response.json()) as AlgoliaResponse;

      for (const hit of data.hits) {
        if (contentType === 'comment') {
          const event = this.transformComment(hit);
          if (event) events.push(event);
        } else {
          events.push(this.transformStory(hit));
        }
      }

      hasMore = data.page < data.nbPages - 1 && data.hits.length > 0;
      page++;

      if (hasMore) {
        await this.sleep(this.PAGE_DELAY_MS);
      }
    }

    // Enrich high-engagement stories with external content
    if (contentType !== 'comment') {
      await this.enrichStoriesWithExternalContent(events);
    }

    return {
      events,
      checkpoint: { last_sync_at: new Date().toISOString() },
      metadata: { items_found: events.length },
    };
  }

  // -------------------------------------------------------------------------
  // execute
  // -------------------------------------------------------------------------

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: 'Actions not supported' };
  }

  // -------------------------------------------------------------------------
  // Transform helpers
  // -------------------------------------------------------------------------

  private transformStory(hit: AlgoliaHit): EventEnvelope {
    const isAskHN = hit._tags.includes('ask_hn');
    const isShowHN = hit._tags.includes('show_hn');

    let storyType = 'story';
    let originType = 'story';
    if (isAskHN) {
      storyType = 'ask_hn';
      originType = 'ask_hn';
    } else if (isShowHN) {
      storyType = 'show_hn';
      originType = 'show_hn';
    }

    const engagementData = {
      score: hit.points ?? 0,
      reply_count: hit.num_comments ?? 0,
    };

    return {
      origin_id: `hn_story_${hit.objectID}`,
      title: hit.title ?? '',
      payload_text: (hit.story_text ?? '').trim(),
      author_name: hit.author,
      source_url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
      occurred_at: new Date(hit.created_at_i * 1000),
      origin_type: originType,
      score: calculateEngagementScore('hackernews', engagementData),
      metadata: {
        type: 'story',
        story_type: storyType,
        tags: hit._tags,
        external_url: hit.url,
        created_at_i: hit.created_at_i,
        score: hit.points ?? 0,
        reply_count: hit.num_comments ?? 0,
      },
    };
  }

  private transformComment(hit: AlgoliaHit): EventEnvelope | null {
    let parentExternalId: string | undefined;
    if (hit.parent_id != null && hit.story_id != null && hit.parent_id !== hit.story_id) {
      parentExternalId = `hn_comment_${hit.parent_id}`;
    } else if (hit.story_id != null) {
      parentExternalId = `hn_story_${hit.story_id}`;
    }

    if (!hit.comment_text) return null;

    return {
      origin_id: `hn_comment_${hit.objectID}`,
      payload_text: hit.comment_text,
      author_name: hit.author,
      source_url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
      occurred_at: new Date(hit.created_at_i * 1000),
      origin_type: 'comment',
      score: calculateEngagementScore('hackernews', { score: 0 }),
      origin_parent_id: parentExternalId,
      metadata: {
        type: 'comment',
        story_id: hit.story_id,
        parent_id: hit.parent_id,
        created_at_i: hit.created_at_i,
        tags: hit._tags,
      },
    };
  }

  // -------------------------------------------------------------------------
  // External content enrichment
  // -------------------------------------------------------------------------

  private async enrichStoriesWithExternalContent(events: EventEnvelope[]): Promise<void> {
    for (const event of events) {
      const externalUrl = event.metadata?.external_url as string | undefined;
      const points = event.metadata?.score as number | undefined;

      if (!event.content && externalUrl && points != null && points >= this.ENGAGEMENT_THRESHOLD) {
        const fetched = await this.fetchExternalContent(externalUrl);
        if (fetched) {
          event.content = fetched;
          event.metadata = {
            ...event.metadata,
            fetched_content: true,
            original_url: externalUrl,
          };
        }

        await this.sleep(this.FETCH_DELAY_MS);
      }
    }
  }

  private async fetchExternalContent(url: string): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.CONTENT_FETCH_TIMEOUT);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; HNBot/1.0)',
          Accept: 'text/html,application/xhtml+xml',
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) return null;

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/html')) return null;

      const html = await response.text();

      // Strip non-article elements
      const stripTags = [
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
      ];
      let cleanHtml = html;
      for (const tag of stripTags) {
        cleanHtml = cleanHtml.replace(
          new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'),
          ''
        );
      }
      cleanHtml = cleanHtml.replace(/<(link|meta|input)\b[^>]*\/?>/gi, '');

      const markdown = this.turndownService.turndown(cleanHtml);
      const trimmed = markdown.trim().substring(0, 2000);

      return trimmed.length >= 100 ? trimmed : null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
