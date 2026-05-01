/**
 * X (Twitter) Connector (V1 runtime)
 *
 * Supports two auth modes:
 * - OAuth 2.0 user context against the X API v2 (preferred when available)
 * - Browser session cookies for scraping/network interception fallback
 */

import {
  type ActionContext,
  type ActionResult,
  browserNetworkSync,
  type ConnectorDefinition,
  ConnectorRuntime,
  calculateEngagementScore,
  type EventEnvelope,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';
import { getBrowserCookies, validateCookieNotExpired } from './browser-scraper-utils';

interface XCheckpoint {
  last_tweet_id?: string;
  last_timestamp?: Date | string;
}

interface XTweet {
  id: string;
  text: string;
  username: string;
  likes: number;
  retweets: number;
  replies: number;
  quotes: number;
  publishedAt: Date;
  isRetweet: boolean;
  isReply: boolean;
  isQuote: boolean;
  conversationId?: string;
  inReplyToId?: string;
}

interface XApiTweetRecord {
  id: string;
  text?: string;
  author_id?: string;
  created_at?: string;
  conversation_id?: string;
  public_metrics?: {
    like_count?: number;
    retweet_count?: number;
    reply_count?: number;
    quote_count?: number;
  };
  referenced_tweets?: Array<{ type?: string; id?: string }>;
}

interface XApiUserRecord {
  id: string;
  username?: string;
  name?: string;
}

interface XApiListResponse {
  data?: XApiTweetRecord[];
  includes?: {
    users?: XApiUserRecord[];
  };
  meta?: {
    next_token?: string;
    result_count?: number;
  };
  errors?: Array<{ detail?: string; message?: string }>;
}

function normalizeHandle(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().replace(/^@+/, '');
  if (!trimmed) return null;
  const match = trimmed.match(/^[A-Za-z0-9_]{1,15}/);
  return match?.[0] ?? null;
}

function buildSearchQuery(config: Record<string, unknown>): string {
  const explicitSearchQuery =
    typeof config.search_query === 'string' ? config.search_query.trim() : '';
  if (explicitSearchQuery.length > 0) {
    return explicitSearchQuery;
  }

  const accountHandle = normalizeHandle(
    typeof config.account_handle === 'string' ? config.account_handle : undefined
  );
  if (!accountHandle) {
    throw new Error('search_query or account_handle is required');
  }

  return `from:${accountHandle}`;
}

function buildApiTweet(
  tweet: XApiTweetRecord,
  usernameById: Map<string, string>,
  defaultUsername?: string
): XTweet | null {
  if (!tweet.id || !tweet.text || !tweet.created_at) return null;

  const referenced = tweet.referenced_tweets ?? [];
  const publicMetrics = tweet.public_metrics ?? {};
  const inReplyToId = referenced.find((ref) => ref.type === 'replied_to')?.id;

  return {
    id: tweet.id,
    text: tweet.text,
    username: usernameById.get(tweet.author_id ?? '') ?? defaultUsername ?? '',
    likes: publicMetrics.like_count ?? 0,
    retweets: publicMetrics.retweet_count ?? 0,
    replies: publicMetrics.reply_count ?? 0,
    quotes: publicMetrics.quote_count ?? 0,
    publishedAt: new Date(tweet.created_at),
    isRetweet: referenced.some((ref) => ref.type === 'retweeted'),
    isReply: Boolean(inReplyToId),
    isQuote: referenced.some((ref) => ref.type === 'quoted'),
    conversationId: tweet.conversation_id,
    inReplyToId,
  };
}

function parseApiListResponse(json: XApiListResponse, defaultUsername?: string): XTweet[] {
  const users = json.includes?.users ?? [];
  const usernameById = new Map(users.map((user) => [user.id, user.username ?? '']));

  return (json.data ?? [])
    .map((tweet) => buildApiTweet(tweet, usernameById, defaultUsername))
    .filter((tweet): tweet is XTweet => tweet !== null);
}

/** Extract tweets from X's GraphQL SearchTimeline response */
function parseBrowserSearchResponse(_url: string, json: unknown): XTweet[] {
  const tweets: XTweet[] = [];
  const data = json as any;

  const instructions =
    data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ?? [];

  for (const instruction of instructions) {
    const entries = instruction.entries ?? instruction.moduleItems ?? [];
    for (const entry of entries) {
      const result =
        entry?.content?.itemContent?.tweet_results?.result ??
        entry?.item?.itemContent?.tweet_results?.result;
      if (!result) continue;

      const legacy = result.legacy ?? result.tweet?.legacy;
      if (!legacy?.full_text) continue;

      const userResult =
        result.core?.user_results?.result ?? result.tweet?.core?.user_results?.result;
      const screenName = userResult?.core?.screen_name ?? userResult?.legacy?.screen_name ?? '';

      tweets.push({
        id: legacy.id_str ?? result.rest_id ?? entry.entryId,
        text: legacy.full_text,
        username: screenName,
        likes: legacy.favorite_count ?? 0,
        retweets: legacy.retweet_count ?? 0,
        replies: legacy.reply_count ?? 0,
        quotes: legacy.quote_count ?? 0,
        publishedAt: new Date(legacy.created_at),
        isRetweet: !!legacy.retweeted_status_result,
        isReply: !!legacy.in_reply_to_status_id_str,
        isQuote: !!legacy.is_quote_status,
        conversationId: legacy.conversation_id_str,
        inReplyToId: legacy.in_reply_to_status_id_str,
      });
    }
  }

  return tweets;
}

function tweetToEvent(tweet: XTweet): EventEnvelope {
  const engagementData = {
    reply_count: tweet.replies,
    upvotes: tweet.likes,
    score: tweet.retweets * 2 + tweet.likes,
  };

  return {
    origin_id: tweet.id,
    payload_text: tweet.text,
    author_name: tweet.username ? `@${tweet.username}` : undefined,
    occurred_at: tweet.publishedAt,
    origin_type: tweet.isReply ? 'reply' : 'tweet',
    score: calculateEngagementScore('x', engagementData),
    source_url: `https://x.com/${tweet.username || 'i'}/status/${tweet.id}`,
    origin_parent_id: tweet.inReplyToId || undefined,
    metadata: {
      ...engagementData,
      retweet_count: tweet.retweets,
      quote_count: tweet.quotes,
      is_retweet: tweet.isRetweet,
      is_reply: tweet.isReply,
      is_quote: tweet.isQuote,
      ...(tweet.conversationId ? { conversation_id: tweet.conversationId } : {}),
    },
  };
}

function finalizeSyncResult(
  tweets: XTweet[],
  checkpoint: XCheckpoint,
  metadata: Record<string, unknown>,
  authUpdate?: Record<string, unknown> | null
): SyncResult {
  const seenIds = new Set<string>();
  const deduped = tweets.filter((tweet) => {
    if (!tweet.id || !tweet.text || seenIds.has(tweet.id)) return false;
    seenIds.add(tweet.id);
    if (checkpoint.last_tweet_id && tweet.id === checkpoint.last_tweet_id) return false;
    return true;
  });

  const events: EventEnvelope[] = deduped.map(tweetToEvent);
  events.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());

  const newestTweetId = events.length > 0 ? events[0].origin_id : checkpoint.last_tweet_id;
  const newCheckpoint: XCheckpoint = {
    last_tweet_id: newestTweetId,
    last_timestamp: events.length > 0 ? events[0].occurred_at : checkpoint.last_timestamp,
  };

  return {
    events,
    checkpoint: newCheckpoint as unknown as Record<string, unknown>,
    ...(authUpdate ? { auth_update: authUpdate } : {}),
    metadata: {
      items_found: events.length,
      items_skipped: tweets.length - deduped.length,
      ...metadata,
    },
  };
}

async function fetchJson<T>(url: URL, accessToken: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`X API request failed (${response.status}): ${text}`);
  }

  return (await response.json()) as T;
}

async function resolveUserId(handle: string, accessToken: string): Promise<string> {
  const url = new URL(`https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}`);
  const json = await fetchJson<{ data?: { id?: string } }>(url, accessToken);
  const userId = json.data?.id;
  if (!userId) {
    throw new Error(`Could not resolve X user id for @${handle}`);
  }
  return userId;
}

async function syncViaOAuthApi(
  ctx: SyncContext,
  config: Record<string, unknown>,
  checkpoint: XCheckpoint
): Promise<SyncResult> {
  const accessToken = ctx.credentials?.accessToken;
  if (!accessToken) {
    throw new Error('OAuth access token missing for X connector');
  }

  const maxPages = Math.max(1, Math.min(50, Number(config.max_scrolls ?? 10) || 10));
  const accountHandle = normalizeHandle(
    typeof config.account_handle === 'string' ? config.account_handle : undefined
  );
  const explicitSearchQuery =
    typeof config.search_query === 'string' ? config.search_query.trim() : '';

  const tweets: XTweet[] = [];
  let pageCount = 0;
  let nextToken: string | undefined;

  if (explicitSearchQuery.length === 0 && accountHandle) {
    const userId = await resolveUserId(accountHandle, accessToken);

    for (let page = 0; page < maxPages; page += 1) {
      const url = new URL(`https://api.x.com/2/users/${encodeURIComponent(userId)}/tweets`);
      url.searchParams.set('max_results', '100');
      url.searchParams.set(
        'tweet.fields',
        'author_id,conversation_id,created_at,public_metrics,referenced_tweets'
      );
      if (checkpoint.last_tweet_id) {
        url.searchParams.set('since_id', checkpoint.last_tweet_id);
      }
      if (nextToken) {
        url.searchParams.set('pagination_token', nextToken);
      }

      const json = await fetchJson<XApiListResponse>(url, accessToken);
      tweets.push(...parseApiListResponse(json, accountHandle));
      pageCount += 1;

      nextToken = json.meta?.next_token;
      if (!nextToken) break;
    }
  } else {
    const searchQuery = buildSearchQuery(config);

    for (let page = 0; page < maxPages; page += 1) {
      const url = new URL('https://api.x.com/2/tweets/search/recent');
      url.searchParams.set('query', searchQuery);
      url.searchParams.set('max_results', '100');
      url.searchParams.set(
        'tweet.fields',
        'author_id,conversation_id,created_at,public_metrics,referenced_tweets'
      );
      url.searchParams.set('expansions', 'author_id');
      url.searchParams.set('user.fields', 'username');
      if (checkpoint.last_tweet_id) {
        url.searchParams.set('since_id', checkpoint.last_tweet_id);
      }
      if (nextToken) {
        url.searchParams.set('next_token', nextToken);
      }

      const json = await fetchJson<XApiListResponse>(url, accessToken);
      tweets.push(...parseApiListResponse(json));
      pageCount += 1;

      nextToken = json.meta?.next_token;
      if (!nextToken) break;
    }
  }

  return finalizeSyncResult(tweets, checkpoint, {
    backend: 'oauth_api',
    api_calls: pageCount,
  });
}

async function syncViaBrowser(
  ctx: SyncContext,
  config: Record<string, unknown>,
  checkpoint: XCheckpoint
): Promise<SyncResult> {
  const searchQuery = buildSearchQuery(config);
  const maxScrolls = (config.max_scrolls as number) ?? 10;
  const searchFilter = (config.search_filter as string) ?? 'live';
  const searchUrl = `https://x.com/search?q=${encodeURIComponent(searchQuery)}&src=typed_query&f=${searchFilter}`;

  let cookies: any[] = [];
  try {
    cookies = getBrowserCookies(ctx.checkpoint as any, ctx.sessionState as any, 'x');
    validateCookieNotExpired(cookies, 'auth_token', 'x');
  } catch {
    // No stored cookies — CDP will be the only path
  }

  const result = await browserNetworkSync<XTweet>({
    config: {
      interceptPatterns: [/\/i\/api\/graphql\/.*Search/],
      authDomains: ['x.com', '.x.com'],
      maxScrolls,
      scrollDelayMs: 2000,
      responseTimeoutMs: 5000,
      navigationTimeoutMs: 15000,
    },
    url: searchUrl,
    cdpUrl: 'auto',
    cookies,
    parseResponse: parseBrowserSearchResponse,
    checkAuth: async (page) => {
      const url = page.url();
      return !url.includes('/login') && !url.includes('/i/flow/login');
    },
  });

  return finalizeSyncResult(
    result.items,
    checkpoint,
    {
      backend: result.backend,
      api_calls: result.apiCallCount,
    },
    { cookies: result.cookies }
  );
}

const configSchema = {
  type: 'object',
  anyOf: [{ required: ['search_query'] }, { required: ['account_handle'] }],
  properties: {
    search_query: {
      type: 'string',
      minLength: 1,
      description: 'Search query for tweets (e.g., "nodejs", "#programming", "from:user")',
    },
    account_handle: {
      type: 'string',
      minLength: 1,
      description:
        'Optional X handle to track directly (e.g. "openai" or "@openai"). Used when search_query is omitted.',
    },
    search_filter: {
      type: 'string',
      enum: ['live', 'top'],
      default: 'live',
      description:
        'Search tab: "live" for Latest (chronological), "top" for Top (popular/algorithmic)',
    },
    max_scrolls: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      default: 10,
      description: 'Maximum pagination iterations (default: 10, API pages or browser scrolls)',
    },
  },
};

const engagementMetadataSchema = {
  type: 'object',
  properties: {
    reply_count: { type: 'number' },
    upvotes: { type: 'number', description: 'Likes' },
    score: { type: 'number' },
    retweet_count: { type: 'number' },
    quote_count: { type: 'number' },
    is_retweet: { type: 'boolean' },
    is_reply: { type: 'boolean' },
    is_quote: { type: 'boolean' },
  },
};

export default class XConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'x',
    name: 'X (Twitter)',
    description: 'Fetches tweets via the X API v2 with browser-cookie fallback.',
    version: '2.1.0',
    faviconDomain: 'x.com',
    authSchema: {
      methods: [
        {
          type: 'oauth',
          provider: 'twitter',
          requiredScopes: ['tweet.read', 'users.read', 'offline.access'],
          optionalScopes: ['users.email', 'follows.read', 'like.read', 'bookmark.read'],
          loginScopes: ['users.read', 'tweet.read', 'offline.access', 'users.email'],
          authorizationUrl: 'https://x.com/i/oauth2/authorize',
          tokenUrl: 'https://api.x.com/2/oauth2/token',
          userinfoUrl: 'https://api.x.com/2/users/me?user.fields=username',
          tokenEndpointAuthMethod: 'client_secret_basic',
          usePkce: true,
          clientIdKey: 'TWITTER_CLIENT_ID',
          clientSecretKey: 'TWITTER_CLIENT_SECRET',
          description:
            'Preferred auth mode. Uses the X OAuth 2.0 API for server-side syncs and login.',
          setupInstructions:
            'Create an X OAuth 2.0 app, add {{redirect_uri}} as the callback URL, then paste the client ID and client secret below.',
          loginProvisioning: {
            autoCreateConnection: true,
          },
        },
        {
          type: 'browser',
          capture: 'cli',
          requiredDomains: ['x.com', '.x.com'],
          description:
            'Fallback for browser-based scraping when API access is unavailable or insufficient.',
        },
      ],
    },
    feeds: {
      tweets: {
        key: 'tweets',
        name: 'Tweets',
        requiredScopes: ['tweet.read', 'users.read'],
        description: 'Search and sync tweets matching a query or a specific account handle.',
        configSchema,
        eventKinds: {
          tweet: {
            description: 'A tweet (original post)',
            metadataSchema: engagementMetadataSchema,
          },
          reply: {
            description: 'A reply to a tweet',
            metadataSchema: {
              ...engagementMetadataSchema,
              properties: {
                ...engagementMetadataSchema.properties,
                conversation_id: { type: 'string' },
              },
            },
          },
        },
      },
    },
    optionsSchema: configSchema,
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const config = ctx.config as Record<string, unknown>;
    const checkpoint = (ctx.checkpoint ?? {}) as XCheckpoint;

    if (ctx.credentials?.accessToken) {
      return syncViaOAuthApi(ctx, config, checkpoint);
    }

    return syncViaBrowser(ctx, config, checkpoint);
  }

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: 'Actions not supported' };
  }
}
