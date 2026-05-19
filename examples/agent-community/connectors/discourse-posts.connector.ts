/**
 * Discourse-posts connector — pulls new posts from a Discourse instance
 * (e.g. https://forum.lobu.ai) and emits one event per post so the
 * `agent-community` agent can index discussions into its knowledge graph
 * and trigger the opportunity-matcher reaction.
 *
 * Auth: a Discourse API key (header `Api-Key`) scoped to a single
 * read-only user. Workers see only the `lobu_secret_<uuid>` placeholder.
 */

import {
  type ActionContext,
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

interface DiscourseConfig {
  base_url: string;
  category_id?: number;
}

interface DiscourseCheckpoint {
  last_post_id: number;
}

interface DiscoursePost {
  id: number;
  topic_id: number;
  topic_slug: string;
  username: string;
  cooked: string;
  created_at: string;
  topic_title?: string;
}

const PAGE_SIZE = 50;

export default class DiscoursePostsConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "discourse-posts",
    name: "Discourse posts",
    description: "Pulls new posts from a Discourse community forum.",
    version: "1.0.0",
    authSchema: {
      methods: [
        {
          type: "env",
          fields: [
            { name: "api_key", description: "Discourse API key" },
            { name: "api_username", description: "Discourse API username" },
          ],
        },
      ],
    },
    feeds: {
      posts: {
        key: "posts",
        name: "Forum posts",
        description: "New posts created since the last post id checkpoint.",
        configSchema: {
          type: "object",
          required: ["base_url"],
          properties: {
            base_url: { type: "string", format: "uri" },
            category_id: { type: "integer" },
          },
        },
        eventKinds: {
          post_created: {
            description: "A new forum post was created.",
            metadataSchema: {
              type: "object",
              properties: {
                topic_id: { type: "integer" },
                topic_title: { type: "string" },
                username: { type: "string" },
              },
            },
          },
        },
      },
    },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const config = ctx.config as unknown as DiscourseConfig;
    if (!config?.base_url) {
      throw new Error("discourse-posts: `base_url` is required");
    }

    const checkpoint = (ctx.checkpoint as DiscourseCheckpoint | null) ?? {
      last_post_id: 0,
    };
    const url = `${config.base_url.replace(/\/$/, "")}/posts.json?before=${checkpoint.last_post_id + PAGE_SIZE}`;
    const posts = await this.fetchPosts(url);
    const fresh = posts
      .filter((p) => p.id > checkpoint.last_post_id)
      .sort((a, b) => a.id - b.id);

    const events: EventEnvelope[] = fresh.map((post) => ({
      origin_id: String(post.id),
      origin_type: "post_created",
      title: post.topic_title ?? `Post by ${post.username}`,
      payload_text: stripHtml(post.cooked).slice(0, 2000),
      author_name: post.username,
      source_url: `${config.base_url}/t/${post.topic_slug}/${post.topic_id}/${post.id}`,
      occurred_at: new Date(post.created_at),
      metadata: {
        topic_id: post.topic_id,
        topic_title: post.topic_title,
        username: post.username,
      },
    }));

    const nextCursor =
      fresh.length === 0 ? checkpoint.last_post_id : fresh[fresh.length - 1].id;

    return {
      events,
      checkpoint: { last_post_id: nextCursor } as unknown as Record<
        string,
        unknown
      >,
      metadata: { items_found: events.length },
    };
  }

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: "Actions not supported" };
  }

  private async fetchPosts(url: string): Promise<DiscoursePost[]> {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Discourse ${response.status}: ${response.statusText}`);
    }
    const body = (await response.json()) as {
      latest_posts?: DiscoursePost[];
    };
    return body.latest_posts ?? [];
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
