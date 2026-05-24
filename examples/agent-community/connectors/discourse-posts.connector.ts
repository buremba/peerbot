// biome-ignore-all format: stays compact for the landing-page code panel
import { ConnectorRuntime, type SyncContext } from "@lobu/connector-sdk";

export default class DiscoursePostsConnector extends ConnectorRuntime {
  readonly definition = {
    key: "discourse-posts",
    name: "Discourse posts",
    version: "1.0.0",
    authSchema: { methods: [{ type: "env_keys" as const, fields: [{ key: "api_key", secret: true }] }] },
    feeds: { posts: { key: "posts", name: "Forum posts" } },
  };

  async sync(ctx: SyncContext) {
    const cursor = (ctx.checkpoint as any)?.last_post_id ?? 0;
    const r = await fetch(`${ctx.config.base_url}/posts.json?before=${cursor + 50}`);
    const posts: any[] = ((await r.json() as any).latest_posts ?? []).filter((p: any) => p.id > cursor).sort((a: any, b: any) => a.id - b.id);
    return {
      events: posts.map((p) => ({
        origin_id: String(p.id),
        origin_type: "post_created",
        title: p.topic_title ?? `Post by ${p.username}`,
        payload_text: p.raw ?? p.cooked ?? `Post by ${p.username}`,
        author_name: p.username,
        source_url: `${ctx.config.base_url}/t/${p.topic_slug}/${p.topic_id}/${p.id}`,
        occurred_at: new Date(p.created_at),
      })),
      checkpoint: { last_post_id: posts.at(-1)?.id ?? cursor },
    };
  }

  async execute() {
    return { success: false, error: "no actions" };
  }
}
