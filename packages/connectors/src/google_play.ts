/**
 * Google Play Store Connector (V1 runtime)
 *
 * Syncs app reviews from the Google Play Store.
 * Directly calls the Play Store batchexecute API instead of using an npm package.
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

// ── Google Play batchexecute API helpers ────────────────────────────

const BASE_URL = 'https://play.google.com';

const SORT = {
  HELPFULNESS: 1,
  NEWEST: 2,
  RATING: 3,
} as const;

/**
 * Build the URL-encoded `f.req` form body for the batchexecute reviews RPC.
 *
 * The body encodes a nested JSON structure:
 *   [["UsvDTd","[null,null,[2,<sort>,[<num>,null,<token>],null,[]],[\"<appId>\",7]]",null,"generic"]]
 *
 * For the initial request the token slot is `null`; for paginated requests it
 * is the string token returned by the previous response.
 */
function buildRequestBody(
  appId: string,
  sort: number,
  numReviews: number,
  token: string | null
): string {
  const tokenPart =
    token === null
      ? `%5B${numReviews}%2Cnull%2Cnull%5D`
      : `%5B${numReviews}%2Cnull%2C%5C%22${token}%5C%22%5D`;

  return `f.req=%5B%5B%5B%22UsvDTd%22%2C%22%5Bnull%2Cnull%2C%5B2%2C${sort}%2C${tokenPart}%2Cnull%2C%5B%5D%5D%2C%5B%5C%22${appId}%5C%22%2C7%5D%5D%22%2Cnull%2C%22generic%22%5D%5D%5D`;
}

function buildBatchUrl(lang: string, country: string): string {
  return `${BASE_URL}/_/PlayStoreUi/data/batchexecute?rpcids=qnKhOb&bl=boq_playuiserver_20190903.08_p0&hl=${lang}&gl=${country}&authuser&soc-app=121&soc-platform=1&soc-device=1&_reqid=1065213`;
}

interface RawReview {
  id: string;
  userName: string;
  userImage: string | null;
  date: string | null;
  score: number;
  text: string;
  replyDate: string | null;
  replyText: string | null;
  version: string | null;
  thumbsUp: number;
  url: string;
}

/**
 * Convert Google's epoch-seconds + partial-millis array into an ISO date string.
 * The date field comes as `[seconds, partialMillis]`.
 */
function parseDate(dateArray: unknown): string | null {
  if (!Array.isArray(dateArray)) return null;
  const milliStr = String(dateArray[1] ?? '000');
  const totalMs = `${dateArray[0]}${milliStr.substring(0, 3)}`;
  return new Date(Number(totalMs)).toJSON();
}

/**
 * Extract structured review objects from the raw nested-array response data.
 */
function extractReviews(data: any[], appId: string): RawReview[] {
  const reviewsList: any[] | undefined = data?.[0];
  if (!Array.isArray(reviewsList)) return [];

  return reviewsList.map((r: any) => ({
    id: r[0] ?? '',
    userName: r[1]?.[0] ?? '',
    userImage: r[1]?.[1]?.[3]?.[2] ?? null,
    date: parseDate(r[5]),
    score: r[2] ?? 0,
    text: r[4] ?? '',
    replyDate: parseDate(r[7]?.[2]),
    replyText: r[7]?.[1] ?? null,
    version: r[10] ?? null,
    thumbsUp: r[6] ?? 0,
    url: `${BASE_URL}/store/apps/details?id=${appId}&reviewId=${r[0] ?? ''}`,
  }));
}

function extractPaginationToken(data: any[]): string | null {
  return data?.[1]?.[1] ?? null;
}

/**
 * Fetch a single page of reviews from the Play Store batchexecute endpoint.
 * Returns the parsed review objects and the next pagination token (if any).
 */
async function fetchReviewsPage(
  appId: string,
  sort: number,
  lang: string,
  country: string,
  token: string | null,
  numPerPage = 150
): Promise<{ reviews: RawReview[]; nextToken: string | null }> {
  const url = buildBatchUrl(lang, country);
  const body = buildRequestBody(appId, sort, numPerPage, token);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body,
  });

  if (!res.ok) {
    if (res.status === 404) throw new Error('App not found (404)');
    throw new Error(`Google Play request failed: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();

  // Response starts with ")]}'" (security prefix), then a newline, then JSON.
  // The library skips the first 5 characters.
  const outer = JSON.parse(text.substring(5));
  const innerJson: string | null = outer?.[0]?.[2];

  if (innerJson === null || innerJson === undefined) {
    return { reviews: [], nextToken: null };
  }

  const data = JSON.parse(innerJson);
  return {
    reviews: extractReviews(data, appId),
    nextToken: extractPaginationToken(data),
  };
}

// ── Connector implementation ────────────────────────────────────────

interface GooglePlayCheckpoint {
  last_timestamp?: string;
  pagination_token?: string;
}

export default class GooglePlayConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'google_play',
    name: 'Google Play Store',
    description: 'Fetches app reviews from the Google Play Store.',
    version: '1.0.0',
    faviconDomain: 'play.google.com',
    authSchema: {
      methods: [{ type: 'none' }],
    },
    feeds: {
      reviews: {
        key: 'reviews',
        name: 'App Reviews',
        description: 'Fetch reviews for an Android app.',
        configSchema: {
          type: 'object',
          required: ['app_id'],
          properties: {
            app_id: {
              type: 'string',
              minLength: 1,
              description: 'Google Play package name (e.g., "com.spotify.music")',
            },
            country: {
              type: 'string',
              minLength: 2,
              maxLength: 2,
              default: 'us',
              description: 'ISO country code',
            },
            lang: {
              type: 'string',
              minLength: 2,
              maxLength: 5,
              default: 'en',
              description: 'Language code',
            },
          },
        },
        eventKinds: {
          review: {
            description: 'A Google Play Store app review',
            metadataSchema: {
              type: 'object',
              properties: {
                rating: { type: 'number', description: 'Star rating (1-5)' },
                thumbs_up: { type: 'number', description: 'Thumbs up count' },
                version: { type: 'string', description: 'App version reviewed' },
                reply: { type: 'string', description: 'Developer reply text' },
                reply_date: { type: 'string', description: 'Developer reply date' },
              },
            },
          },
        },
      },
    },
    optionsSchema: {
      type: 'object',
      required: ['app_id'],
      properties: {
        app_id: {
          type: 'string',
          minLength: 1,
          description: 'Google Play package name (e.g., "com.spotify.music")',
        },
        country: {
          type: 'string',
          minLength: 2,
          maxLength: 2,
          default: 'us',
          description: 'ISO country code',
        },
        lang: {
          type: 'string',
          minLength: 2,
          maxLength: 5,
          default: 'en',
          description: 'Language code',
        },
      },
    },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const app_id = ctx.config.app_id as string;
    const country = (ctx.config.country as string) || 'us';
    const lang = (ctx.config.lang as string) || 'en';
    const checkpoint = (ctx.checkpoint ?? {}) as GooglePlayCheckpoint;

    const MAX_REVIEWS = 500;
    const allReviews: RawReview[] = [];
    let nextToken: string | null = checkpoint.pagination_token ?? null;
    const lastTimestamp = checkpoint.last_timestamp
      ? new Date(checkpoint.last_timestamp).getTime()
      : null;
    let hitCheckpoint = false;

    while (allReviews.length < MAX_REVIEWS) {
      const page = await fetchReviewsPage(app_id, SORT.HELPFULNESS, lang, country, nextToken);

      if (page.reviews.length === 0) break;

      if (lastTimestamp) {
        for (const review of page.reviews) {
          const reviewTime = review.date ? new Date(review.date).getTime() : 0;
          if (reviewTime > lastTimestamp) {
            allReviews.push(review);
          } else {
            hitCheckpoint = true;
            break;
          }
        }
        if (hitCheckpoint) break;
      } else {
        allReviews.push(...page.reviews);
      }

      nextToken = page.nextToken;
      if (!nextToken) break;

      // Rate-limit delay between pagination requests
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Transform to EventEnvelope format — skip reviews without text
    const events: EventEnvelope[] = allReviews
      .filter((review) => review.text)
      .map((review) => {
        const rating = review.score || 0;
        const thumbsUp = review.thumbsUp || 0;
        const replyCount = review.replyDate ? 1 : 0;

        return {
          origin_id: review.id,
          payload_text: review.text,
          author_name: review.userName || undefined,
          occurred_at: review.date ? new Date(review.date) : new Date(),
          origin_type: 'review',
          score: calculateEngagementScore('google_play', {
            rating,
            helpful_count: thumbsUp,
            reply_count: replyCount,
          }),
          source_url: review.url,
          metadata: {
            rating,
            thumbs_up: thumbsUp,
            version: review.version,
            reply: review.replyText,
            reply_date: review.replyDate,
          },
        };
      });

    // Sort by published date descending
    events.sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());

    const newCheckpoint: GooglePlayCheckpoint =
      events.length > 0
        ? {
            last_timestamp: events[0].occurred_at.toISOString(),
            pagination_token: nextToken ?? undefined,
          }
        : {
            last_timestamp: checkpoint.last_timestamp,
            pagination_token: checkpoint.pagination_token,
          };

    return {
      events,
      checkpoint: newCheckpoint as Record<string, unknown>,
      metadata: {
        items_found: allReviews.length,
        items_skipped: 0,
      },
    };
  }

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: 'Actions not supported' };
  }
}
