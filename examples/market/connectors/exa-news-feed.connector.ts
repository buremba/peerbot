import { ConnectorRuntime, type SyncContext } from "@lobu/connector-sdk";

export default class ExaNewsFeedConnector extends ConnectorRuntime {
  readonly definition = {
    key: "exa-news-feed",
    name: "Exa news feed",
    version: "1.0.0",
    authSchema: { methods: [{ type: "env" as const, fields: [{ name: "api_key" }] }] },
    feeds: { articles: { key: "articles", name: "Articles" } },
  };

  async sync(ctx: SyncContext) {
    const seen = new Set<string>((ctx.checkpoint as { seen_ids?: string[] } | null)?.seen_ids ?? []);
    const r = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: ctx.config.query, numResults: ctx.config.num_results ?? 20 }),
    });
    const { results = [] } = (await r.json()) as { results?: Array<{ id: string; title?: string; url: string; author?: string; publishedDate?: string }> };
    const fresh = results.filter((x) => x.id && !seen.has(x.id));
    return {
      events: fresh.map((x) => ({
        origin_id: x.id,
        origin_type: "article_published",
        title: x.title ?? x.url,
        author_name: x.author,
        source_url: x.url,
        occurred_at: x.publishedDate ? new Date(x.publishedDate) : new Date(),
      })),
      checkpoint: { seen_ids: [...seen, ...fresh.map((x) => x.id)].slice(-1000) } as Record<string, unknown>,
    };
  }

  async execute() {
    return { success: false, error: "no actions" };
  }
}
