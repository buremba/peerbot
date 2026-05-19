import { ConnectorRuntime, type SyncContext } from "@lobu/connector-sdk";

export default class DiscoursePostsConnector extends ConnectorRuntime {
  readonly definition = {
    key: "discourse-posts",
    name: "Discourse posts",
    version: "1.0.0",
    authSchema: { methods: [{ type: "env" as const, fields: [{ name: "api_key" }] }] },
    feeds: { posts: { key: "posts", name: "Forum posts" } },
  };

  async sync(ctx: SyncContext) {
    const cursor = (ctx.checkpoint as { last_post_id?: number } | null)?.last_post_id ?? 0;
    const r = await fetch(`${ctx.config.base_url}/posts.json?before=${cursor + 50}`);
    const body = (await r.json()) as { latest_posts?: Array<{ id: number; topic_id: number; topic_slug: string; username: string; cooked: string; created_at: string; topic_title?: string }> };
    const posts = (body.latest_posts ?? []).filter((p) => p.id > cursor).sort((a, b) => a.id - b.id);
    return {
      events: posts.map((p) => ({
        origin_id: String(p.id),
        origin_type: "post_created",
        title: p.topic_title ?? `Post by ${p.username}`,
        author_name: p.username,
        source_url: `${ctx.config.base_url}/t/${p.topic_slug}/${p.topic_id}/${p.id}`,
        occurred_at: new Date(p.created_at),
      })),
      checkpoint: { last_post_id: posts.at(-1)?.id ?? cursor } as Record<string, unknown>,
    };
  }

  async execute() {
    return { success: false, error: "no actions" };
  }
}
