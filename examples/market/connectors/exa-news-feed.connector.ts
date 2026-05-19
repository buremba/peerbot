import {
  type ConnectorDefinition,
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

type Result = { id: string; title?: string; url: string; text?: string; author?: string; publishedDate?: string };

export default class ExaNewsFeedConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "exa-news-feed",
    name: "Exa news feed",
    description: "Runs a saved Exa neural search and emits one event per fresh article.",
    version: "1.0.0",
    authSchema: { methods: [{ type: "env", fields: [{ name: "api_key" }] }] },
    feeds: { articles: { key: "articles", name: "Articles" } },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const seen = new Set<string>(
      (ctx.checkpoint as { seen_ids?: string[] } | null)?.seen_ids ?? []
    );
    const r = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: ctx.config.query, numResults: ctx.config.num_results ?? 20, includeDomains: ctx.config.include_domains, contents: { text: { maxCharacters: 3000 } } }),
    });
    const { results = [] } = (await r.json()) as { results?: Result[] };
    const fresh = results.filter((x) => x.id && !seen.has(x.id));
    return {
      events: fresh.map((x) => ({
        origin_id: x.id,
        origin_type: "article_published",
        title: x.title ?? x.url,
        payload_text: x.text?.slice(0, 3000),
        author_name: x.author,
        source_url: x.url,
        occurred_at: x.publishedDate ? new Date(x.publishedDate) : new Date(),
      })),
      checkpoint: {
        seen_ids: [...seen, ...fresh.map((x) => x.id)].slice(-1000),
      } as unknown as Record<string, unknown>,
    };
  }
}
