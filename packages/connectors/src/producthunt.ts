/**
 * Product Hunt Connector (V1 runtime)
 *
 * Searches Product Hunt posts and comments via the GraphQL API.
 * Supports both authenticated (Developer Token) and unauthenticated modes.
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

// ---------------------------------------------------------------------------
// Product Hunt GraphQL API types
// ---------------------------------------------------------------------------

interface ProductHuntMaker {
  name: string;
}

interface ProductHuntTopicEdge {
  node: {
    name: string;
  };
}

interface ProductHuntComment {
  id: string;
  body: string;
  createdAt: string;
  votesCount: number;
  user: {
    name: string;
  };
}

interface ProductHuntCommentEdge {
  node: ProductHuntComment;
}

interface ProductHuntPost {
  id: string;
  name: string;
  tagline: string;
  description: string;
  url: string;
  votesCount: number;
  commentsCount: number;
  createdAt: string;
  makers: ProductHuntMaker[];
  topics: {
    edges: ProductHuntTopicEdge[];
  };
  comments: {
    edges: ProductHuntCommentEdge[];
  };
}

interface ProductHuntPostEdge {
  node: ProductHuntPost;
  cursor: string;
}

interface ProductHuntPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface ProductHuntPostsResponse {
  data: {
    posts: {
      edges: ProductHuntPostEdge[];
      pageInfo: ProductHuntPageInfo;
    };
  };
  errors?: Array<{ message: string }>;
}

interface ProductHuntCheckpoint {
  last_cursor?: string;
  last_sync_at?: string;
}

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

const LIST_POSTS_QUERY = `
query ListPosts($topic: String, $postedAfter: DateTime, $after: String) {
  posts(topic: $topic, postedAfter: $postedAfter, after: $after, first: 10, order: NEWEST) {
    edges {
      node {
        id
        name
        tagline
        description
        url
        votesCount
        commentsCount
        createdAt
        makers { name }
        topics { edges { node { name } } }
        comments(first: 10) {
          edges {
            node {
              id
              body
              createdAt
              votesCount
              user { name }
            }
          }
        }
      }
      cursor
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class ProductHuntConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'producthunt',
    name: 'Product Hunt',
    description: 'Searches Product Hunt posts and comments for a given query.',
    version: '1.0.0',
    faviconDomain: 'producthunt.com',
    authSchema: {
      methods: [
        {
          type: 'env_keys',
          required: false,
          fields: [
            {
              key: 'PRODUCTHUNT_TOKEN',
              label: 'Product Hunt Developer Token',
              description:
                'Create at producthunt.com/v2/oauth/applications — add an app, then copy the Developer Token.',
              secret: true,
            },
          ],
        },
      ],
    },
    feeds: {
      posts: {
        key: 'posts',
        name: 'Posts & Comments',
        description: 'Search Product Hunt for posts and their comments.',
        configSchema: {
          type: 'object',
          required: ['search_query'],
          properties: {
            search_query: {
              type: 'string',
              minLength: 1,
              description: 'Search term to find posts on Product Hunt.',
            },
            lookback_days: {
              type: 'integer',
              minimum: 1,
              maximum: 730,
              default: 365,
              description: 'Number of days to look back for historical data.',
            },
            max_pages: {
              type: 'integer',
              minimum: 1,
              maximum: 50,
              default: 10,
              description: 'Maximum number of pages to fetch.',
            },
          },
        },
        eventKinds: {
          post: {
            description: 'A Product Hunt launch/post',
            metadataSchema: {
              type: 'object',
              properties: {
                tagline: { type: 'string', description: 'Short tagline for the product' },
                votes_count: { type: 'number', description: 'Number of upvotes' },
                comments_count: { type: 'number', description: 'Number of comments' },
                makers: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Names of the product makers',
                },
                topics: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Topic tags',
                },
              },
            },
          },
          comment: {
            description: 'A comment on a Product Hunt post',
            metadataSchema: {
              type: 'object',
              properties: {
                votes_count: { type: 'number', description: 'Number of upvotes on the comment' },
                post_id: { type: 'string', description: 'ID of the parent post' },
                post_name: { type: 'string', description: 'Name of the parent post' },
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
          description: 'Search term to find posts on Product Hunt.',
        },
        lookback_days: {
          type: 'integer',
          minimum: 1,
          maximum: 730,
          default: 365,
          description: 'Number of days to look back for historical data.',
        },
        max_pages: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 10,
          description: 'Maximum number of pages to fetch.',
        },
      },
    },
  };

  private readonly API_URL = 'https://api.producthunt.com/v2/api/graphql';
  private readonly RATE_LIMIT_MS = 1000;

  // -------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const searchQuery = ctx.config.search_query as string;
    const lookbackDays = (ctx.config.lookback_days as number) ?? 365;
    const maxPages = (ctx.config.max_pages as number) ?? 10;
    const token = ctx.config.PRODUCTHUNT_TOKEN as string | undefined;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - lookbackDays);

    const previousCheckpoint = ctx.checkpoint as ProductHuntCheckpoint | null;

    const events: EventEnvelope[] = [];
    const seenIds = new Set<string>();
    let cursor: string | null = previousCheckpoint?.last_cursor ?? null;
    let page = 0;
    let reachedCutoff = false;

    while (page < maxPages && !reachedCutoff) {
      const variables: Record<string, string | null> = {
        postedAfter: cutoffDate.toISOString(),
        after: cursor,
      };

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(this.API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: LIST_POSTS_QUERY,
          variables,
        }),
      });

      if (!response.ok) {
        const status = response.status;
        if (status === 429) {
          throw new Error('Product Hunt rate limit exceeded. Please wait before retrying.');
        }
        if (status === 401) {
          if (!token) {
            // PH v2 API requires auth; return empty results when no token configured
            console.warn(
              'Product Hunt API requires a Developer Token. Configure PRODUCTHUNT_TOKEN for results.'
            );
            break;
          }
          throw new Error('Product Hunt authentication failed. Check your Developer Token.');
        }
        throw new Error(`Product Hunt API error (${status}): ${await response.text()}`);
      }

      const result = (await response.json()) as ProductHuntPostsResponse;

      if (result.errors && result.errors.length > 0) {
        throw new Error(
          `Product Hunt GraphQL error: ${result.errors.map((e) => e.message).join(', ')}`
        );
      }

      const edges = result.data.posts.edges;
      if (edges.length === 0) break;

      const queryLower = searchQuery.toLowerCase();

      for (const edge of edges) {
        const post = edge.node;
        const postDate = new Date(post.createdAt);

        if (postDate < cutoffDate) {
          reachedCutoff = true;
          break;
        }

        // Client-side filter: match search query in name, tagline, or description
        const matchesQuery =
          post.name.toLowerCase().includes(queryLower) ||
          post.tagline.toLowerCase().includes(queryLower) ||
          (post.description ?? '').toLowerCase().includes(queryLower) ||
          post.topics?.edges?.some((t) => t.node.name.toLowerCase().includes(queryLower));

        if (!matchesQuery) continue;

        // Add post event
        const postExternalId = `producthunt_post_${post.id}`;
        if (!seenIds.has(postExternalId)) {
          seenIds.add(postExternalId);
          events.push(this.transformPost(post));
        }

        // Add comment events
        if (post.comments?.edges) {
          for (const commentEdge of post.comments.edges) {
            const comment = commentEdge.node;
            const commentExternalId = `producthunt_comment_${comment.id}`;
            if (!seenIds.has(commentExternalId)) {
              seenIds.add(commentExternalId);
              events.push(this.transformComment(comment, post));
            }
          }
        }
      }

      const pageInfo = result.data.posts.pageInfo;
      if (!pageInfo.hasNextPage) break;

      cursor = pageInfo.endCursor;
      page++;

      if (page < maxPages && !reachedCutoff) {
        await this.sleep(this.RATE_LIMIT_MS);
      }
    }

    // Sort events by occurred_at descending
    events.sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());

    const checkpoint: ProductHuntCheckpoint = {
      last_cursor: cursor ?? undefined,
      last_sync_at: new Date().toISOString(),
    };

    return {
      events,
      checkpoint: checkpoint as Record<string, unknown>,
      metadata: {
        items_found: events.length,
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
  // Transform helpers
  // -------------------------------------------------------------------------

  private transformPost(post: ProductHuntPost): EventEnvelope {
    const makers = post.makers.map((m) => m.name);
    const topics = post.topics.edges.map((e) => e.node.name);

    const engagementScore = calculateEngagementScore('producthunt', {
      upvotes: post.votesCount,
      reply_count: post.commentsCount,
    });

    const description = post.description ?? '';
    const content = description.trim() || post.tagline;

    return {
      origin_id: `producthunt_post_${post.id}`,
      title: post.name,
      payload_text: content,
      author_name: makers.join(', ') || undefined,
      source_url: post.url,
      occurred_at: new Date(post.createdAt),
      origin_type: 'post',
      score: engagementScore,
      metadata: {
        tagline: post.tagline,
        votes_count: post.votesCount,
        comments_count: post.commentsCount,
        makers,
        topics,
      },
    };
  }

  private transformComment(
    comment: ProductHuntComment,
    parentPost: ProductHuntPost
  ): EventEnvelope {
    const engagementScore = calculateEngagementScore('producthunt', {
      upvotes: comment.votesCount,
    });

    return {
      origin_id: `producthunt_comment_${comment.id}`,
      payload_text: comment.body ?? '',
      author_name: comment.user.name,
      source_url: parentPost.url,
      occurred_at: new Date(comment.createdAt),
      origin_type: 'comment',
      score: engagementScore,
      origin_parent_id: `producthunt_post_${parentPost.id}`,
      metadata: {
        votes_count: comment.votesCount,
        post_id: parentPost.id,
        post_name: parentPost.name,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
