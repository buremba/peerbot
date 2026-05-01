/**
 * GitHub Connector (V1 runtime)
 *
 * Syncs GitHub repository content and executes write actions.
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

type GitHubContentType =
  | 'issues'
  | 'pull_requests'
  | 'issue_comments'
  | 'pr_comments'
  | 'discussions'
  | 'discussion_comments';

interface GitHubConfig {
  repo_owner?: string;
  repo_name?: string;
  content_type?: GitHubContentType;
  lookback_days?: number;
  labels_filter?: string[];
  env_overrides?: Record<string, unknown>;
}

interface GitHubCheckpoint {
  last_sync_at?: string;
}

interface RepoRef {
  owner: string;
  repo: string;
}

interface GitHubIssueLike {
  id: number;
  number: number;
  title: string;
  body: string | null;
  user?: { login?: string };
  html_url: string;
  created_at: string;
  updated_at: string;
  state: string;
  labels?: Array<{ name?: string }>;
  comments?: number;
  reactions?: { '+1'?: number; '-1'?: number; total_count?: number };
  pull_request?: Record<string, unknown>;
}

interface GitHubCommentLike {
  id: number;
  body: string;
  user?: { login?: string };
  html_url: string;
  issue_url?: string;
  pull_request_url?: string;
  created_at: string;
  updated_at: string;
  reactions?: { '+1'?: number; '-1'?: number; total_count?: number };
}

interface GraphQLDiscussionNode {
  id: string;
  number: number;
  title: string;
  body: string;
  author?: { login?: string };
  url: string;
  createdAt: string;
  updatedAt: string;
  category?: { name?: string };
  comments?: { totalCount?: number };
  reactions?: { totalCount?: number };
}

interface GraphQLDiscussionCommentNode {
  id: string;
  body: string;
  author?: { login?: string };
  url: string;
  createdAt: string;
  updatedAt: string;
  reactions?: { totalCount?: number };
  discussion?: { number?: number };
}

function toInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function toIsoOrUndefined(value: unknown): string | undefined {
  const str = asString(value);
  if (!str) return undefined;
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function stripMarkdown(code: string): string {
  return code
    .replace(/```[a-zA-Z]*\n?/g, '')
    .replace(/```/g, '')
    .trim();
}

const REPO_PROPS = {
  repo_owner: { type: 'string', minLength: 1, description: 'Repository owner' },
  repo_name: { type: 'string', minLength: 1, description: 'Repository name' },
} as const;

const LOOKBACK_PROP = {
  lookback_days: {
    type: 'integer',
    minimum: 1,
    maximum: 730,
    default: 365,
    description: 'Initial sync lookback window',
  },
} as const;

const LABELS_PROP = {
  labels_filter: {
    type: 'array',
    items: { type: 'string' },
    description: 'Optional label filter',
  },
} as const;

export default class GitHubConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'github',
    name: 'GitHub',
    description: 'Collects GitHub issues/discussions and executes repo actions.',
    version: '1.1.0',
    authSchema: {
      methods: [
        {
          type: 'oauth',
          provider: 'github',
          requiredScopes: ['read:user'],
          optionalScopes: ['repo'],
          loginScopes: ['read:user', 'user:email'],
          clientIdKey: 'GITHUB_CLIENT_ID',
          clientSecretKey: 'GITHUB_CLIENT_SECRET',
          tokenUrl: 'https://github.com/login/oauth/access_token',
          tokenEndpointAuthMethod: 'client_secret_post',
          required: false,
          description:
            'GitHub OAuth enables repo access for this connection. Upgrade to the optional repo scope for private repositories and write actions.',
          loginProvisioning: {
            autoCreateConnection: true,
          },
          setupInstructions:
            'Create a GitHub OAuth App in GitHub Settings > Developer settings > OAuth Apps. Set the authorization callback URL to {{redirect_uri}}, then copy the client ID and client secret below.',
        },
        {
          type: 'env_keys',
          required: false,
          description: 'Optional fallback token for sync/action calls.',
          fields: [
            {
              key: 'GITHUB_TOKEN',
              label: 'GitHub Token',
              description: 'Personal access token used as fallback auth for API requests.',
              secret: true,
            },
          ],
        },
      ],
    },
    feeds: {
      issues: {
        key: 'issues',
        name: 'Issues',
        requiredScopes: [],
        description: 'Sync GitHub issues from a repository.',
        displayNameTemplate: '{repo_owner}/{repo_name} issues',
        configSchema: {
          type: 'object',
          required: ['repo_owner', 'repo_name'],
          properties: { ...REPO_PROPS, ...LABELS_PROP, ...LOOKBACK_PROP },
        },
        eventKinds: {
          issue: {
            description: 'A GitHub issue',
            metadataSchema: {
              type: 'object',
              properties: {
                number: { type: 'number' },
                state: { type: 'string' },
                labels: { type: 'array', items: { type: 'string' } },
                updated_at: { type: 'string' },
                reactions: { type: 'object' },
                comments: { type: 'number' },
              },
            },
          },
        },
      },
      pull_requests: {
        key: 'pull_requests',
        name: 'Pull Requests',
        requiredScopes: [],
        description: 'Sync GitHub pull requests from a repository.',
        displayNameTemplate: '{repo_owner}/{repo_name} PRs',
        configSchema: {
          type: 'object',
          required: ['repo_owner', 'repo_name'],
          properties: { ...REPO_PROPS, ...LABELS_PROP, ...LOOKBACK_PROP },
        },
        eventKinds: {
          pull_request: {
            description: 'A GitHub pull request',
            metadataSchema: {
              type: 'object',
              properties: {
                number: { type: 'number' },
                state: { type: 'string' },
                labels: { type: 'array', items: { type: 'string' } },
                updated_at: { type: 'string' },
                reactions: { type: 'object' },
                comments: { type: 'number' },
              },
            },
          },
        },
      },
      issue_comments: {
        key: 'issue_comments',
        name: 'Issue Comments',
        requiredScopes: [],
        description: 'Sync comments on GitHub issues.',
        displayNameTemplate: '{repo_owner}/{repo_name} issue comments',
        configSchema: {
          type: 'object',
          required: ['repo_owner', 'repo_name'],
          properties: { ...REPO_PROPS, ...LOOKBACK_PROP },
        },
        eventKinds: {
          issue_comment: {
            description: 'A comment on a GitHub issue',
            metadataSchema: {
              type: 'object',
              properties: {
                updated_at: { type: 'string' },
                reactions: { type: 'object' },
              },
            },
          },
        },
      },
      pr_comments: {
        key: 'pr_comments',
        name: 'PR Comments',
        requiredScopes: [],
        description: 'Sync comments on GitHub pull requests.',
        displayNameTemplate: '{repo_owner}/{repo_name} PR comments',
        configSchema: {
          type: 'object',
          required: ['repo_owner', 'repo_name'],
          properties: { ...REPO_PROPS, ...LOOKBACK_PROP },
        },
        eventKinds: {
          pr_comment: {
            description: 'A comment on a GitHub pull request',
            metadataSchema: {
              type: 'object',
              properties: {
                updated_at: { type: 'string' },
                reactions: { type: 'object' },
              },
            },
          },
        },
      },
      discussions: {
        key: 'discussions',
        name: 'Discussions',
        requiredScopes: [],
        description: 'Sync GitHub discussions from a repository.',
        displayNameTemplate: '{repo_owner}/{repo_name} discussions',
        configSchema: {
          type: 'object',
          required: ['repo_owner', 'repo_name'],
          properties: { ...REPO_PROPS, ...LOOKBACK_PROP },
        },
        eventKinds: {
          discussion: {
            description: 'A GitHub discussion',
            metadataSchema: {
              type: 'object',
              properties: {
                number: { type: 'number' },
                category: { type: 'string' },
                updated_at: { type: 'string' },
                comments: { type: 'number' },
                reactions: { type: 'number' },
              },
            },
          },
        },
      },
      discussion_comments: {
        key: 'discussion_comments',
        name: 'Discussion Comments',
        requiredScopes: [],
        description: 'Sync comments on GitHub discussions.',
        displayNameTemplate: '{repo_owner}/{repo_name} discussion comments',
        configSchema: {
          type: 'object',
          required: ['repo_owner', 'repo_name'],
          properties: { ...REPO_PROPS, ...LOOKBACK_PROP },
        },
        eventKinds: {
          discussion_comment: {
            description: 'A comment on a GitHub discussion',
            metadataSchema: {
              type: 'object',
              properties: {
                discussion_number: { type: 'number' },
                updated_at: { type: 'string' },
                reactions: { type: 'number' },
              },
            },
          },
        },
      },
    },
    actions: {
      create_issue: {
        key: 'create_issue',
        name: 'Create Issue',
        description: 'Create a new issue in the configured repository.',
        requiresApproval: true,
        inputSchema: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
            labels: { type: 'array', items: { type: 'string' } },
            assignees: { type: 'array', items: { type: 'string' } },
            repo_owner: { type: 'string' },
            repo_name: { type: 'string' },
          },
        },
      },
      add_issue_comment: {
        key: 'add_issue_comment',
        name: 'Add Issue Comment',
        description: 'Add a comment to an issue or pull request.',
        requiresApproval: true,
        inputSchema: {
          type: 'object',
          required: ['issue_number', 'body'],
          properties: {
            issue_number: { type: 'integer' },
            body: { type: 'string' },
            repo_owner: { type: 'string' },
            repo_name: { type: 'string' },
          },
        },
      },
      close_issue: {
        key: 'close_issue',
        name: 'Close Issue',
        description: 'Close an issue by number.',
        requiresApproval: true,
        inputSchema: {
          type: 'object',
          required: ['issue_number'],
          properties: {
            issue_number: { type: 'integer' },
            repo_owner: { type: 'string' },
            repo_name: { type: 'string' },
          },
        },
      },
      reopen_issue: {
        key: 'reopen_issue',
        name: 'Reopen Issue',
        description: 'Reopen an issue by number.',
        requiresApproval: true,
        inputSchema: {
          type: 'object',
          required: ['issue_number'],
          properties: {
            issue_number: { type: 'integer' },
            repo_owner: { type: 'string' },
            repo_name: { type: 'string' },
          },
        },
      },
      create_pull_request: {
        key: 'create_pull_request',
        name: 'Create Pull Request',
        description: 'Create a pull request from head to base branch.',
        requiresApproval: true,
        inputSchema: {
          type: 'object',
          required: ['title', 'head', 'base'],
          properties: {
            title: { type: 'string' },
            head: { type: 'string' },
            base: { type: 'string' },
            body: { type: 'string' },
            draft: { type: 'boolean' },
            repo_owner: { type: 'string' },
            repo_name: { type: 'string' },
          },
        },
      },
      merge_pull_request: {
        key: 'merge_pull_request',
        name: 'Merge Pull Request',
        description: 'Merge a pull request by number.',
        requiresApproval: true,
        inputSchema: {
          type: 'object',
          required: ['pull_number'],
          properties: {
            pull_number: { type: 'integer' },
            merge_method: {
              type: 'string',
              enum: ['merge', 'squash', 'rebase'],
            },
            commit_title: { type: 'string' },
            commit_message: { type: 'string' },
            repo_owner: { type: 'string' },
            repo_name: { type: 'string' },
          },
        },
      },
    },
    optionsSchema: {
      type: 'object',
      required: ['repo_owner', 'repo_name'],
      properties: { ...REPO_PROPS, ...LABELS_PROP, ...LOOKBACK_PROP },
    },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const config = this.parseConfig(ctx.config);
    const repo = this.resolveRepo(config, {});
    const token = this.resolveToken(ctx.credentials?.accessToken, config);
    const contentType = (ctx.feedKey ?? 'issues') as GitHubContentType;
    const sinceIso = this.resolveSince(ctx.checkpoint, config.lookback_days ?? 365);

    const events = await this.syncContent({
      repo,
      contentType,
      sinceIso,
      labelsFilter: config.labels_filter ?? [],
      token,
    });

    return {
      events,
      checkpoint: {
        last_sync_at: new Date().toISOString(),
      } as Record<string, unknown>,
      metadata: {
        items_found: events.length,
      },
    };
  }

  async execute(ctx: ActionContext): Promise<ActionResult> {
    try {
      const config = this.parseConfig(ctx.config);
      const repo = this.resolveRepo(config, ctx.input);
      const token = this.resolveToken(ctx.credentials?.accessToken, config);

      if (!token) {
        return { success: false, error: 'GitHub action requires OAuth or GITHUB_TOKEN.' };
      }

      switch (ctx.actionKey) {
        case 'create_issue':
          return await this.createIssue(repo, token, ctx.input);
        case 'add_issue_comment':
          return await this.addIssueComment(repo, token, ctx.input);
        case 'close_issue':
          return await this.updateIssueState(repo, token, ctx.input, 'closed');
        case 'reopen_issue':
          return await this.updateIssueState(repo, token, ctx.input, 'open');
        case 'create_pull_request':
          return await this.createPullRequest(repo, token, ctx.input);
        case 'merge_pull_request':
          return await this.mergePullRequest(repo, token, ctx.input);
        default:
          return { success: false, error: `Unknown action: ${ctx.actionKey}` };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private parseConfig(raw: Record<string, unknown>): GitHubConfig {
    return raw as GitHubConfig;
  }

  private resolveRepo(config: GitHubConfig, input: Record<string, unknown>): RepoRef {
    const owner = asString(input.repo_owner) ?? config.repo_owner;
    const repo = asString(input.repo_name) ?? config.repo_name;

    if (!owner || !repo) {
      throw new Error(
        'Repository is not configured. Provide repo_owner/repo_name in connection config or action input.'
      );
    }

    return { owner, repo };
  }

  private resolveToken(oauthToken: string | undefined, config: GitHubConfig): string | null {
    if (oauthToken && oauthToken.trim().length > 0) {
      return oauthToken;
    }

    const envOverrides = config.env_overrides ?? {};
    const configuredToken =
      asString(envOverrides.GITHUB_TOKEN) ??
      asString((config as Record<string, unknown>).GITHUB_TOKEN) ??
      asString((config as Record<string, unknown>).github_token);

    return configuredToken ?? null;
  }

  private resolveSince(checkpoint: Record<string, unknown> | null, lookbackDays: number): string {
    const cp = (checkpoint ?? {}) as GitHubCheckpoint;
    const fromCheckpoint = toIsoOrUndefined(cp.last_sync_at);
    if (fromCheckpoint) return fromCheckpoint;

    const fallback = new Date();
    fallback.setDate(fallback.getDate() - lookbackDays);
    return fallback.toISOString();
  }

  private async syncContent(params: {
    repo: RepoRef;
    contentType: GitHubContentType;
    sinceIso: string;
    labelsFilter: string[];
    token: string | null;
  }): Promise<EventEnvelope[]> {
    const { repo, contentType, sinceIso, labelsFilter, token } = params;

    switch (contentType) {
      case 'issues':
      case 'pull_requests':
        return await this.syncIssuesAndPulls(repo, contentType, sinceIso, labelsFilter, token);
      case 'issue_comments':
        return await this.syncIssueComments(repo, sinceIso, token);
      case 'pr_comments':
        return await this.syncPullRequestComments(repo, sinceIso, token);
      case 'discussions':
        return await this.syncDiscussions(repo, sinceIso, token);
      case 'discussion_comments':
        return await this.syncDiscussionComments(repo, sinceIso, token);
      default:
        return [];
    }
  }

  private async syncIssuesAndPulls(
    repo: RepoRef,
    contentType: 'issues' | 'pull_requests',
    sinceIso: string,
    labelsFilter: string[],
    token: string | null
  ): Promise<EventEnvelope[]> {
    const query = new URLSearchParams({
      state: 'all',
      per_page: '100',
      sort: 'updated',
      direction: 'desc',
      since: sinceIso,
    });
    if (labelsFilter.length > 0) {
      query.set('labels', labelsFilter.join(','));
    }

    const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/issues?${query.toString()}`;
    const items = await this.requestJson<GitHubIssueLike[]>({ url, token });
    const events: EventEnvelope[] = [];

    for (const item of items) {
      const isPR = !!item.pull_request;
      if (contentType === 'issues' && isPR) continue;
      if (contentType === 'pull_requests' && !isPR) continue;

      const createdAt = new Date(item.created_at);
      if (Number.isNaN(createdAt.getTime())) continue;

      const score = toInt(item.reactions?.total_count, 0) + toInt(item.comments, 0);
      const labels = Array.isArray(item.labels)
        ? item.labels.map((label) => label.name).filter((v): v is string => !!v)
        : [];

      events.push({
        origin_id: `${isPR ? 'pr' : 'issue'}_${repo.owner}_${repo.repo}_${item.number}`,
        title: item.title,
        payload_text: (item.body ?? '').trim(),
        author_name: item.user?.login,
        source_url: item.html_url,
        occurred_at: createdAt,
        origin_type: isPR ? 'pull_request' : 'issue',
        score,
        metadata: {
          number: item.number,
          state: item.state,
          labels,
          updated_at: item.updated_at,
          reactions: item.reactions ?? {},
          comments: item.comments ?? 0,
        },
      });
    }

    return events;
  }

  private async syncIssueComments(
    repo: RepoRef,
    sinceIso: string,
    token: string | null
  ): Promise<EventEnvelope[]> {
    const query = new URLSearchParams({
      per_page: '100',
      sort: 'updated',
      direction: 'desc',
      since: sinceIso,
    });
    const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/issues/comments?${query.toString()}`;
    const comments = await this.requestJson<GitHubCommentLike[]>({ url, token });

    return comments
      .map((comment): EventEnvelope | null => {
        const createdAt = new Date(comment.created_at);
        if (Number.isNaN(createdAt.getTime())) return null;
        if (!comment.body) return null;

        const issueNumber = comment.issue_url?.match(/\/issues\/(\d+)$/)?.[1];
        return {
          origin_id: `issue_comment_${repo.owner}_${repo.repo}_${comment.id}`,
          payload_text: comment.body,
          author_name: comment.user?.login,
          source_url: comment.html_url,
          occurred_at: createdAt,
          origin_type: 'issue_comment',
          score: toInt(comment.reactions?.total_count, 0),
          origin_parent_id: issueNumber
            ? `issue_${repo.owner}_${repo.repo}_${issueNumber}`
            : undefined,
          metadata: {
            updated_at: comment.updated_at,
            reactions: comment.reactions ?? {},
          },
        };
      })
      .filter((value): value is EventEnvelope => value !== null);
  }

  private async syncPullRequestComments(
    repo: RepoRef,
    sinceIso: string,
    token: string | null
  ): Promise<EventEnvelope[]> {
    const query = new URLSearchParams({
      per_page: '100',
      sort: 'updated',
      direction: 'desc',
      since: sinceIso,
    });
    const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/comments?${query.toString()}`;
    const comments = await this.requestJson<GitHubCommentLike[]>({ url, token });

    return comments
      .map((comment): EventEnvelope | null => {
        const createdAt = new Date(comment.created_at);
        if (Number.isNaN(createdAt.getTime())) return null;
        if (!comment.body) return null;

        const prNumber = comment.pull_request_url?.match(/\/pulls\/(\d+)$/)?.[1];
        return {
          origin_id: `pr_comment_${repo.owner}_${repo.repo}_${comment.id}`,
          payload_text: comment.body,
          author_name: comment.user?.login,
          source_url: comment.html_url,
          occurred_at: createdAt,
          origin_type: 'pr_comment',
          score: toInt(comment.reactions?.total_count, 0),
          origin_parent_id: prNumber ? `pr_${repo.owner}_${repo.repo}_${prNumber}` : undefined,
          metadata: {
            updated_at: comment.updated_at,
            reactions: comment.reactions ?? {},
          },
        };
      })
      .filter((value): value is EventEnvelope => value !== null);
  }

  private async syncDiscussions(
    repo: RepoRef,
    sinceIso: string,
    token: string | null
  ): Promise<EventEnvelope[]> {
    const query = `
      query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          discussions(first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes {
              id
              number
              title
              body
              author { login }
              url
              createdAt
              updatedAt
              category { name }
              comments { totalCount }
              reactions { totalCount }
            }
          }
        }
      }
    `;

    const response = await this.requestGraphQL<{
      data?: {
        repository?: {
          discussions?: { nodes?: GraphQLDiscussionNode[] };
        };
      };
    }>({
      token,
      query,
      variables: { owner: repo.owner, repo: repo.repo },
    });

    const discussions = response.data?.repository?.discussions?.nodes ?? [];
    const since = new Date(sinceIso).getTime();

    return discussions
      .map((discussion): EventEnvelope | null => {
        const createdAt = new Date(discussion.createdAt);
        const updatedAt = new Date(discussion.updatedAt).getTime();
        if (Number.isNaN(createdAt.getTime())) return null;
        if (!Number.isNaN(since) && updatedAt < since) return null;

        return {
          origin_id: `discussion_${repo.owner}_${repo.repo}_${discussion.number}`,
          title: discussion.title,
          payload_text: (discussion.body ?? '').trim(),
          author_name: discussion.author?.login,
          source_url: discussion.url,
          occurred_at: createdAt,
          origin_type: 'discussion',
          score:
            toInt(discussion.reactions?.totalCount, 0) + toInt(discussion.comments?.totalCount, 0),
          metadata: {
            number: discussion.number,
            category: discussion.category?.name ?? null,
            updated_at: discussion.updatedAt,
            comments: discussion.comments?.totalCount ?? 0,
            reactions: discussion.reactions?.totalCount ?? 0,
          },
        };
      })
      .filter((value): value is EventEnvelope => value !== null);
  }

  private async syncDiscussionComments(
    repo: RepoRef,
    sinceIso: string,
    token: string | null
  ): Promise<EventEnvelope[]> {
    const query = `
      query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          discussions(first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes {
              number
              comments(first: 50) {
                nodes {
                  id
                  body
                  url
                  createdAt
                  updatedAt
                  author { login }
                  reactions { totalCount }
                }
              }
            }
          }
        }
      }
    `;

    const response = await this.requestGraphQL<{
      data?: {
        repository?: {
          discussions?: {
            nodes?: Array<{
              number: number;
              comments?: { nodes?: Array<Omit<GraphQLDiscussionCommentNode, 'discussion'>> };
            }>;
          };
        };
      };
    }>({
      token,
      query,
      variables: { owner: repo.owner, repo: repo.repo },
    });

    const discussions = response.data?.repository?.discussions?.nodes ?? [];
    const since = new Date(sinceIso).getTime();
    const result: EventEnvelope[] = [];

    for (const discussion of discussions) {
      const comments = discussion.comments?.nodes ?? [];
      for (const comment of comments) {
        const createdAt = new Date(comment.createdAt);
        const updatedAt = new Date(comment.updatedAt).getTime();
        if (Number.isNaN(createdAt.getTime())) continue;
        if (!Number.isNaN(since) && updatedAt < since) continue;
        if (!comment.body?.trim()) continue;

        result.push({
          origin_id: `discussion_comment_${repo.owner}_${repo.repo}_${comment.id}`,
          payload_text: comment.body.trim(),
          author_name: comment.author?.login,
          source_url: comment.url,
          occurred_at: createdAt,
          origin_type: 'discussion_comment',
          score: toInt(comment.reactions?.totalCount, 0),
          origin_parent_id: `discussion_${repo.owner}_${repo.repo}_${discussion.number}`,
          metadata: {
            discussion_number: discussion.number,
            updated_at: comment.updatedAt,
            reactions: comment.reactions?.totalCount ?? 0,
          },
        });
      }
    }

    return result;
  }

  private async createIssue(
    repo: RepoRef,
    token: string,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const title = asString(input.title);
    if (!title) return { success: false, error: 'title is required' };

    const body = asString(input.body);
    const labels = Array.isArray(input.labels)
      ? input.labels.filter((value): value is string => typeof value === 'string')
      : undefined;
    const assignees = Array.isArray(input.assignees)
      ? input.assignees.filter((value): value is string => typeof value === 'string')
      : undefined;

    const issue = await this.requestJson<{
      id: number;
      number: number;
      html_url: string;
      state: string;
    }>({
      method: 'POST',
      url: `https://api.github.com/repos/${repo.owner}/${repo.repo}/issues`,
      token,
      body: {
        title,
        body,
        labels,
        assignees,
      },
    });

    return {
      success: true,
      output: {
        issue_id: issue.id,
        issue_number: issue.number,
        url: issue.html_url,
        state: issue.state,
      },
    };
  }

  private async addIssueComment(
    repo: RepoRef,
    token: string,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const issueNumber = toInt(input.issue_number, 0);
    const body = asString(input.body);
    if (!issueNumber) return { success: false, error: 'issue_number is required' };
    if (!body) return { success: false, error: 'body is required' };

    const comment = await this.requestJson<{
      id: number;
      html_url: string;
    }>({
      method: 'POST',
      url: `https://api.github.com/repos/${repo.owner}/${repo.repo}/issues/${issueNumber}/comments`,
      token,
      body: { body },
    });

    return {
      success: true,
      output: {
        comment_id: comment.id,
        issue_number: issueNumber,
        url: comment.html_url,
      },
    };
  }

  private async updateIssueState(
    repo: RepoRef,
    token: string,
    input: Record<string, unknown>,
    state: 'open' | 'closed'
  ): Promise<ActionResult> {
    const issueNumber = toInt(input.issue_number, 0);
    if (!issueNumber) return { success: false, error: 'issue_number is required' };

    const issue = await this.requestJson<{
      id: number;
      number: number;
      html_url: string;
      state: string;
    }>({
      method: 'PATCH',
      url: `https://api.github.com/repos/${repo.owner}/${repo.repo}/issues/${issueNumber}`,
      token,
      body: { state },
    });

    return {
      success: true,
      output: {
        issue_id: issue.id,
        issue_number: issue.number,
        url: issue.html_url,
        state: issue.state,
      },
    };
  }

  private async createPullRequest(
    repo: RepoRef,
    token: string,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const title = asString(input.title);
    const head = asString(input.head);
    const base = asString(input.base);
    if (!title) return { success: false, error: 'title is required' };
    if (!head) return { success: false, error: 'head is required' };
    if (!base) return { success: false, error: 'base is required' };

    const body = asString(input.body);
    const draft = typeof input.draft === 'boolean' ? input.draft : undefined;

    const pr = await this.requestJson<{
      id: number;
      number: number;
      html_url: string;
      state: string;
      draft?: boolean;
    }>({
      method: 'POST',
      url: `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls`,
      token,
      body: {
        title,
        head,
        base,
        body,
        draft,
      },
    });

    return {
      success: true,
      output: {
        pull_request_id: pr.id,
        pull_number: pr.number,
        url: pr.html_url,
        state: pr.state,
        draft: pr.draft ?? false,
      },
    };
  }

  private async mergePullRequest(
    repo: RepoRef,
    token: string,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const pullNumber = toInt(input.pull_number, 0);
    if (!pullNumber) return { success: false, error: 'pull_number is required' };

    const mergeMethod = asString(input.merge_method);
    const commitTitle = asString(input.commit_title);
    const commitMessage = asString(input.commit_message);

    const merged = await this.requestJson<{
      sha: string;
      merged: boolean;
      message: string;
    }>({
      method: 'PUT',
      url: `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/${pullNumber}/merge`,
      token,
      body: {
        merge_method:
          mergeMethod === 'merge' || mergeMethod === 'squash' || mergeMethod === 'rebase'
            ? mergeMethod
            : undefined,
        commit_title: commitTitle,
        commit_message: commitMessage ? stripMarkdown(commitMessage) : undefined,
      },
    });

    return {
      success: true,
      output: {
        pull_number: pullNumber,
        merged: !!merged.merged,
        message: merged.message,
        sha: merged.sha,
      },
    };
  }

  private async requestGraphQL<T>(params: {
    token: string | null;
    query: string;
    variables?: Record<string, unknown>;
  }): Promise<T> {
    return await this.requestJson<T>({
      method: 'POST',
      url: 'https://api.github.com/graphql',
      token: params.token,
      body: {
        query: params.query,
        variables: params.variables ?? {},
      },
    });
  }

  private async requestJson<T>(params: {
    url: string;
    method?: string;
    token: string | null;
    body?: Record<string, unknown>;
  }): Promise<T> {
    const method = params.method ?? 'GET';
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
    if (params.token) {
      headers.Authorization = `Bearer ${params.token}`;
    }

    const response = await fetch(params.url, {
      method,
      headers,
      body: params.body ? JSON.stringify(params.body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API ${method} ${params.url} failed (${response.status}): ${text}`);
    }

    return (await response.json()) as T;
  }
}
