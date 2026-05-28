/**
 * LinkedIn Connector
 *
 * Scrapes LinkedIn company pages via the paired Owletto Chrome extension's
 * network-intercept primitive. The extension runs inside the user's real
 * Chrome session — no Playwright, no cookie cache, no `--remote-debugging-
 * port` plumbing. We attach the CDP Network domain in the user's signed-in
 * tab, drive scroll pagination, and parse the Voyager API responses the
 * page emits.
 *
 * Auth is implicit: the user is already signed into linkedin.com in the
 * paired Chrome. There is no fallback path — if no online Owletto extension
 * is reachable in the connection's org, this sync fails fast with a clear
 * "no paired Owletto extension" error.
 */

import {
  type ChromeActionDispatcher,
  type ConnectorDefinition,
  ConnectorRuntime,
  calculateEngagementScore,
  type EventEnvelope,
  extensionNetworkSync,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

// ── Types ──────────────────────────────────────────────────────

interface LinkedInCheckpoint {
  last_post_id?: string;
  last_job_id?: string;
  last_timestamp?: string;
}

interface LinkedInPost {
  id: string;
  text: string;
  author: string;
  authorHeadline?: string;
  likes: number;
  comments: number;
  shares: number;
  publishedAt: Date;
}

interface LinkedInJob {
  id: string;
  title: string;
  location: string;
  postedAt: Date;
  url: string;
  description?: string;
}

function normalizeCheckpointPostId(postId?: string): string | undefined {
  if (!postId) return undefined;
  return postId.startsWith('li_post_') ? postId.slice('li_post_'.length) : postId;
}

/**
 * Pull the chrome action dispatcher from sessionState. The connector-worker
 * subprocess (child-runner.ts) splices a live `chrome_dispatcher` object
 * onto every sync's sessionState; the dispatcher's `dispatch()` rides an
 * IPC channel up to the daemon and out to the gateway's
 * /api/workers/dispatch-chrome-action bridge. When no paired Owletto
 * extension is online in the connection's org, the bridge returns the
 * `failed` status and the dispatcher throws — we surface that as the sync
 * failure verbatim.
 */
function requireExtensionDispatcher(ctx: SyncContext): ChromeActionDispatcher {
  const handle = (ctx.sessionState as Record<string, unknown> | null | undefined)
    ?.chrome_dispatcher as ChromeActionDispatcher | undefined;
  if (!handle || typeof handle.dispatch !== 'function') {
    throw new Error(
      'LinkedIn connector requires a paired Owletto Chrome extension. No chrome_dispatcher was injected into sessionState — re-run on a connector-worker that has the dispatcher bridge.'
    );
  }
  return handle;
}

export function filterPostsSinceCheckpoint(
  posts: LinkedInPost[],
  checkpoint: LinkedInCheckpoint
): LinkedInPost[] {
  const seenIds = new Set<string>();
  const checkpointPostId = normalizeCheckpointPostId(checkpoint.last_post_id);
  const checkpointTimestamp = checkpoint.last_timestamp
    ? new Date(checkpoint.last_timestamp).getTime()
    : null;

  const filtered: LinkedInPost[] = [];
  for (const post of posts) {
    if (!post.id || !post.text || seenIds.has(post.id)) continue;
    seenIds.add(post.id);

    if (checkpointPostId && post.id === checkpointPostId) break;
    if (checkpointTimestamp !== null && post.publishedAt.getTime() <= checkpointTimestamp) {
      continue;
    }

    filtered.push(post);
  }

  return filtered;
}

// ── Voyager API Response Parsers ──────────────────────────────

function parseCompanyUpdates(_url: string, json: unknown): LinkedInPost[] {
  const posts: LinkedInPost[] = [];
  const data = json as any;

  // Build URN lookup from `included` array (LinkedIn GraphQL uses references)
  const included: any[] = data?.included ?? [];
  const byUrn: Record<string, any> = {};
  for (const item of included) {
    const urn = item.entityUrn || item.$id;
    if (urn) byUrn[urn] = item;
  }

  // Find feed elements - LinkedIn nests under data.data with a long key
  const feedRoot = data?.data?.data ?? data?.data ?? data;
  let elements: any[] = [];
  for (const key of Object.keys(feedRoot)) {
    const val = feedRoot[key];
    if (val?.['*elements'] && Array.isArray(val['*elements'])) {
      elements = val['*elements'];
      break;
    }
    if (val?.elements && Array.isArray(val.elements)) {
      elements = val.elements;
      break;
    }
  }

  const resolve = (ref: any) => (typeof ref === 'string' ? byUrn[ref] : ref) ?? {};

  for (const ref of elements) {
    const el = resolve(ref);

    // Get commentary text (may be a reference)
    const commentaryObj = resolve(el['*commentary'] ?? el.commentary);
    const textObj = commentaryObj?.text ?? commentaryObj;
    const text = textObj?.text ?? textObj?.attributedText?.text ?? '';
    if (!text) continue;

    // Get actor
    const actorObj = resolve(el['*actor'] ?? el.actor);
    const authorName = actorObj?.name?.text ?? actorObj?.name ?? 'Unknown';
    const authorDesc = actorObj?.description?.text ?? actorObj?.description ?? undefined;

    // Get social counts
    const socialRef = el['*socialDetail'] ?? el.socialDetail;
    const social = resolve(socialRef);
    const counts =
      social?.totalSocialActivityCounts ??
      social?.socialActivityCountsInsight?.totalSocialActivityCounts ??
      {};

    // Get URN for ID
    const urn = el.entityUrn ?? el['*backendUrn'] ?? '';
    const urnParts = urn.split(':');
    const id =
      urnParts[urnParts.length - 1] || `li_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Get timestamp
    const metadata = resolve(el['*metadata'] ?? el.metadata);
    const publishedAt = metadata?.publishedAt ?? el.createdAt ?? Date.now();

    posts.push({
      id,
      text,
      author: authorName,
      authorHeadline: typeof authorDesc === 'string' ? authorDesc : undefined,
      likes: counts.numLikes ?? 0,
      comments: counts.numComments ?? 0,
      shares: counts.numShares ?? 0,
      publishedAt: new Date(publishedAt),
    });
  }

  return posts;
}

function parseJobListings(_url: string, json: unknown): LinkedInJob[] {
  const jobs: LinkedInJob[] = [];
  const data = json as any;

  const elements = data?.elements ?? data?.data?.elements ?? [];

  for (const element of elements) {
    const jobPosting = element?.jobPosting ?? element;
    const title = jobPosting?.title ?? element?.title ?? '';
    if (!title) continue;

    const urnParts = (jobPosting?.entityUrn ?? element?.dashEntityUrn ?? '').split(':');
    const id =
      urnParts[urnParts.length - 1] ||
      `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    jobs.push({
      id,
      title,
      location: jobPosting?.formattedLocation ?? jobPosting?.location ?? '',
      postedAt: new Date(jobPosting?.listedAt ?? element?.createdAt ?? Date.now()),
      url: `https://www.linkedin.com/jobs/view/${id}`,
      description: jobPosting?.description?.text ?? undefined,
    });
  }

  return jobs;
}

// ── Config Schemas ────────────────────────────────────────────

const companyUpdatesConfigSchema = {
  type: 'object',
  required: ['company_url'],
  properties: {
    company_url: {
      type: 'string',
      description: 'LinkedIn company page URL (e.g., "https://www.linkedin.com/company/openai")',
    },
    max_scrolls: {
      type: 'integer',
      minimum: 1,
      maximum: 20,
      default: 5,
      description: 'Maximum scroll iterations for pagination (default: 5)',
    },
  },
};

const jobsConfigSchema = {
  type: 'object',
  required: ['company_url'],
  properties: {
    company_url: {
      type: 'string',
      description: 'LinkedIn company page URL (e.g., "https://www.linkedin.com/company/openai")',
    },
    max_scrolls: {
      type: 'integer',
      minimum: 1,
      maximum: 10,
      default: 3,
      description: 'Maximum scroll iterations for job listings (default: 3)',
    },
  },
};

// ── Connector ─────────────────────────────────────────────────

export default class LinkedInConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'linkedin',
    name: 'LinkedIn',
    description:
      'Scrapes LinkedIn company pages for posts, hiring signals, and team data via the paired Owletto Chrome extension.',
    version: '2.0.0',
    faviconDomain: 'linkedin.com',
    authSchema: {
      methods: [
        {
          type: 'none',
        },
        {
          type: 'oauth',
          provider: 'linkedin',
          requiredScopes: ['openid', 'profile', 'email'],
          loginScopes: ['openid', 'profile', 'email'],
          authorizationUrl: 'https://www.linkedin.com/oauth/v2/authorization',
          tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
          userinfoUrl: 'https://api.linkedin.com/v2/userinfo',
          tokenEndpointAuthMethod: 'client_secret_post',
          clientIdKey: 'LINKEDIN_CLIENT_ID',
          clientSecretKey: 'LINKEDIN_CLIENT_SECRET',
          description:
            'Optional LinkedIn OAuth app config for sign-in. Current company page and jobs feeds run via the Chrome extension; OAuth is here for downstream sign-in flows.',
          setupInstructions:
            'Create a LinkedIn OAuth app, add {{redirect_uri}} as the callback URL, then paste the client ID and client secret below.',
        },
      ],
    },
    feeds: {
      company_updates: {
        key: 'company_updates',
        name: 'Company Updates',
        description: 'Posts and updates from the company LinkedIn page.',
        configSchema: companyUpdatesConfigSchema,
        eventKinds: {
          post: {
            description: 'A company LinkedIn post',
            metadataSchema: {
              type: 'object',
              properties: {
                author_headline: { type: 'string' },
                likes: { type: 'number' },
                comments: { type: 'number' },
                shares: { type: 'number' },
              },
            },
          },
        },
      },
      jobs: {
        key: 'jobs',
        name: 'Job Listings',
        description: 'Open job positions (hiring velocity signal).',
        configSchema: jobsConfigSchema,
        eventKinds: {
          job_posting: {
            description: 'An open job listing',
            metadataSchema: {
              type: 'object',
              properties: {
                location: { type: 'string' },
              },
            },
          },
        },
      },
    },
    optionsSchema: companyUpdatesConfigSchema,
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const config = ctx.config as Record<string, unknown>;
    const checkpoint = (ctx.checkpoint ?? {}) as LinkedInCheckpoint;
    const feedKey = ctx.feedKey ?? 'company_updates';

    const companyUrl = config.company_url as string;
    if (!companyUrl) {
      throw new Error('company_url is required');
    }

    // Normalize URL - remove trailing slash
    const baseUrl = companyUrl.replace(/\/$/, '');
    const maxScrolls = (config.max_scrolls as number) ?? (feedKey === 'jobs' ? 3 : 5);

    const dispatcher = requireExtensionDispatcher(ctx);
    if (feedKey === 'jobs') {
      return this.syncJobs(baseUrl, maxScrolls, checkpoint, dispatcher);
    }
    return this.syncUpdates(baseUrl, maxScrolls, checkpoint, dispatcher);
  }

  private async syncUpdates(
    baseUrl: string,
    maxScrolls: number,
    checkpoint: LinkedInCheckpoint,
    dispatcher: ChromeActionDispatcher
  ): Promise<SyncResult> {
    const postsUrl = `${baseUrl}/posts/`;
    const result = await extensionNetworkSync<LinkedInPost>({
      dispatcher,
      url: postsUrl,
      config: {
        interceptPatterns: [
          { regex: 'voyager/api/graphql\\?variables=.*ORGANIZATION_MEMBER_FEED' },
          { regex: 'voyager/api/graphql\\?variables=.*organizationalPageUrn' },
        ],
        allowedOrigins: ['linkedin.com', '*.linkedin.com'],
        maxScrolls,
        scrollDelayMs: 3000,
        responseTimeoutMs: 8000,
      },
      parseResponse: parseCompanyUpdates,
      checkAuth: (currentUrl) =>
        !currentUrl.includes('/login') && !currentUrl.includes('/authwall'),
    });

    const posts = filterPostsSinceCheckpoint(result.items, checkpoint);
    const events: EventEnvelope[] = posts.map((post) => ({
      origin_id: `li_post_${post.id}`,
      payload_text: post.text,
      author_name: post.author,
      occurred_at: post.publishedAt,
      origin_type: 'post',
      source_url: `https://www.linkedin.com/feed/update/urn:li:activity:${post.id}`,
      score: calculateEngagementScore('linkedin', {
        upvotes: post.likes,
        reply_count: post.comments,
      }),
      metadata: {
        author_headline: post.authorHeadline,
        likes: post.likes,
        comments: post.comments,
        shares: post.shares,
      },
    }));
    events.sort(
      (a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime()
    );

    return {
      events,
      checkpoint: {
        last_post_id: posts[0]?.id ?? checkpoint.last_post_id,
        last_timestamp: events[0]?.occurred_at?.toISOString?.() ?? checkpoint.last_timestamp,
      } as unknown as Record<string, unknown>,
      // No cookie persistence — auth lives in the user's signed-in Chrome,
      // not in our cookie cache.
      metadata: {
        items_found: events.length,
        items_skipped: result.items.length - posts.length,
        api_calls: result.apiCallCount,
        backend: 'extension',
      },
    };
  }

  private async syncJobs(
    baseUrl: string,
    maxScrolls: number,
    checkpoint: LinkedInCheckpoint,
    dispatcher: ChromeActionDispatcher
  ): Promise<SyncResult> {
    const jobsUrl = `${baseUrl}/jobs/`;
    const result = await extensionNetworkSync<LinkedInJob>({
      dispatcher,
      url: jobsUrl,
      config: {
        interceptPatterns: [
          { regex: 'voyager/api/graphql.*jobPosting', flags: 'i' },
          { regex: 'voyager/api/search/dash/.*jobs', flags: 'i' },
          { regex: 'voyager/api/organization/.*jobs', flags: 'i' },
        ],
        allowedOrigins: ['linkedin.com', '*.linkedin.com'],
        maxScrolls,
        scrollDelayMs: 3000,
        responseTimeoutMs: 8000,
      },
      parseResponse: parseJobListings,
      checkAuth: (currentUrl) =>
        !currentUrl.includes('/login') && !currentUrl.includes('/authwall'),
    });

    const seenIds = new Set<string>();
    const jobs = result.items.filter((j) => {
      if (!j.id || seenIds.has(j.id)) return false;
      seenIds.add(j.id);
      return true;
    });
    jobs.sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());

    const events: EventEnvelope[] = jobs.map((job) => ({
      origin_id: `li_job_${job.id}`,
      payload_text: job.description ?? job.title,
      title: job.title,
      occurred_at: job.postedAt,
      origin_type: 'job_posting',
      source_url: job.url,
      metadata: { location: job.location },
    }));

    return {
      events,
      checkpoint: {
        last_job_id: jobs[0]?.id ?? checkpoint.last_job_id,
        last_timestamp: jobs[0]?.postedAt?.toISOString?.() ?? checkpoint.last_timestamp,
      } as unknown as Record<string, unknown>,
      metadata: {
        items_found: events.length,
        api_calls: result.apiCallCount,
        backend: 'extension',
      },
    };
  }
}
