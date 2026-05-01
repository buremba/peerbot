/**
 * iOS App Store Connector (V1 runtime)
 *
 * Fetches app reviews from the Apple App Store via RSS feeds.
 */

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

const IOS_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://apps.apple.com/',
};

interface IOSCheckpoint {
  last_timestamp?: string;
}

interface RSSFeed {
  feed?: {
    entry?: RSSEntry | RSSEntry[];
  };
}

interface RSSEntry {
  id?: { label?: string };
  title?: { label?: string };
  content?: { label?: string };
  author?: { name?: { label?: string } };
  updated?: { label?: string };
  link?: { attributes?: { href?: string } };
  'im:rating'?: { label?: string };
  'im:voteSum'?: { label?: string };
  'im:voteCount'?: { label?: string };
  'im:version'?: { label?: string };
}

const FEED_CONFIG_SCHEMA = {
  type: 'object',
  required: ['app_id', 'country'],
  properties: {
    app_id: {
      type: 'string',
      minLength: 1,
      description: 'iOS App Store ID (e.g., "324684580")',
    },
    country: {
      type: 'string',
      minLength: 2,
      maxLength: 2,
      pattern: '^[A-Z]{2}$',
      description: 'ISO country code (e.g., "US")',
    },
  },
} as const;

export default class IOSAppStoreConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'ios_appstore',
    name: 'iOS App Store',
    description: 'Fetches app reviews from the Apple App Store via RSS feeds.',
    version: '1.0.0',
    faviconDomain: 'apple.com',
    authSchema: {
      methods: [{ type: 'none' }],
    },
    feeds: {
      reviews: {
        key: 'reviews',
        name: 'App Reviews',
        description: 'Fetch reviews for an iOS app.',
        configSchema: FEED_CONFIG_SCHEMA,
        eventKinds: {
          review: {
            description: 'An iOS App Store review',
            metadataSchema: {
              type: 'object',
              properties: {
                rating: { type: 'number', description: 'Star rating (1-5)' },
                vote_sum: { type: 'number', description: 'Net helpful votes' },
                vote_count: { type: 'number', description: 'Total vote count' },
                version: { type: 'string', description: 'App version reviewed' },
              },
            },
          },
        },
      },
    },
    optionsSchema: FEED_CONFIG_SCHEMA,
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const appId = ctx.config.app_id as string;
    const country = ctx.config.country as string;
    const checkpoint = (ctx.checkpoint ?? {}) as IOSCheckpoint;
    const lastTimestamp = checkpoint.last_timestamp ? new Date(checkpoint.last_timestamp) : null;

    const MAX_PAGES = 10;
    const allReviews: RSSEntry[] = [];
    let shouldContinue = true;

    for (let page = 1; shouldContinue && page <= MAX_PAGES; page++) {
      const rssUrl = `https://itunes.apple.com/${country}/rss/customerreviews/page=${page}/id=${appId}/sortby=mostrecent/json`;

      const response = await fetch(rssUrl, { headers: IOS_HEADERS });
      if (!response.ok) {
        if (page === 1) {
          throw new Error(`RSS feed returned ${response.status}: ${rssUrl}`);
        }
        break;
      }

      let rssData: RSSFeed;
      try {
        rssData = await response.json();
      } catch {
        if (page === 1) {
          const text = await response.text();
          throw new Error(`RSS feed returned invalid JSON: ${text.substring(0, 100)}`);
        }
        break;
      }

      const rawEntries = rssData.feed?.entry;
      const feedEntries: RSSEntry[] = Array.isArray(rawEntries)
        ? rawEntries
        : rawEntries
          ? [rawEntries]
          : [];

      if (feedEntries.length === 0) {
        break;
      }

      // Filter out the first entry on page 1 if it lacks im:rating (app metadata entry)
      const reviews = feedEntries.filter((entry, index) => {
        if (page === 1 && index === 0 && !entry['im:rating']) {
          return false;
        }
        return !!entry['im:rating'];
      });

      if (reviews.length === 0) {
        break;
      }

      // Check if the oldest review on this page is older than or equal to the checkpoint
      if (lastTimestamp) {
        const oldestReviewDate = new Date(reviews[reviews.length - 1].updated?.label || Date.now());
        if (oldestReviewDate <= lastTimestamp) {
          // Add only reviews newer than the checkpoint and stop
          allReviews.push(
            ...reviews.filter((r) => new Date(r.updated?.label || Date.now()) > lastTimestamp)
          );
          shouldContinue = false;
          break;
        }
      }

      allReviews.push(...reviews);

      // 1 second delay between pages
      if (shouldContinue && page < MAX_PAGES) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    // Transform reviews to EventEnvelope format
    const appUrl = `https://apps.apple.com/${country.toLowerCase()}/app/id${appId}`;

    const events: EventEnvelope[] = allReviews.map((review) => {
      const rating = parseInt(review['im:rating']?.label || '0', 10);
      const title = review.title?.label || '';
      const body = review.content?.label || '';
      const content = title ? `${title}\n\n${body}` : body;

      return {
        origin_id: review.id?.label || '',
        payload_text: content,
        author_name: review.author?.name?.label || undefined,
        occurred_at: new Date(review.updated?.label || Date.now()),
        origin_type: 'review',
        score: calculateEngagementScore('ios_appstore', { rating }),
        source_url: review.link?.attributes?.href || appUrl,
        metadata: {
          rating,
          vote_sum: parseInt(review['im:voteSum']?.label || '0', 10),
          vote_count: parseInt(review['im:voteCount']?.label || '0', 10),
          version: review['im:version']?.label,
        },
      };
    });

    // Sort descending by occurred_at
    events.sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());

    // Build new checkpoint from the most recent event
    const newCheckpoint: IOSCheckpoint =
      events.length > 0
        ? { last_timestamp: events[0].occurred_at.toISOString() }
        : { last_timestamp: checkpoint.last_timestamp };

    return {
      events,
      checkpoint: newCheckpoint as Record<string, unknown>,
      metadata: {
        items_found: allReviews.length,
      },
    };
  }

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: 'Actions not supported' };
  }
}
