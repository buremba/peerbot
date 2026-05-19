/**
 * Exa-news-feed connector — runs an Exa neural search on a recurring
 * schedule and emits one event per fresh article. The `market` agent uses
 * the events to build Company / Funding / Person entities and to fan
 * founder-activity reactions out over Slack.
 *
 * Auth: an Exa API key (header `x-api-key`). Workers see only the secret
 * placeholder.
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

interface ExaConfig {
  query: string;
  num_results?: number;
  include_domains?: string[];
}

interface ExaCheckpoint {
  seen_ids: string[];
}

interface ExaResult {
  id: string;
  title?: string;
  url: string;
  text?: string;
  author?: string;
  publishedDate?: string;
}

const MAX_DEDUP_IDS = 1000;
const ENDPOINT = "https://api.exa.ai/search";

export default class ExaNewsFeedConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "exa-news-feed",
    name: "Exa news feed",
    description:
      "Runs a saved Exa neural search and emits one event per fresh article.",
    version: "1.0.0",
    authSchema: {
      methods: [
        {
          type: "env",
          fields: [{ name: "api_key", description: "Exa API key" }],
        },
      ],
    },
    feeds: {
      articles: {
        key: "articles",
        name: "Articles",
        description: "Fresh articles matching the configured Exa query.",
        configSchema: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", description: "Exa search prompt" },
            num_results: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              default: 20,
            },
            include_domains: {
              type: "array",
              items: { type: "string" },
              description: "Restrict results to these domains.",
            },
          },
        },
        eventKinds: {
          article_published: {
            description: "An article matching the saved query was published.",
            metadataSchema: {
              type: "object",
              properties: {
                url: { type: "string" },
                author: { type: "string" },
              },
            },
          },
        },
      },
    },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const config = ctx.config as unknown as ExaConfig;
    if (!config?.query) {
      throw new Error("exa-news-feed: `query` is required");
    }

    const checkpoint = (ctx.checkpoint as ExaCheckpoint | null) ?? {
      seen_ids: [],
    };
    const seen = new Set<string>(checkpoint.seen_ids ?? []);

    const results = await this.search(config);
    const newIds: string[] = [];
    const events: EventEnvelope[] = [];
    for (const result of results) {
      if (!result.id || seen.has(result.id)) continue;
      seen.add(result.id);
      newIds.push(result.id);
      events.push({
        origin_id: result.id,
        origin_type: "article_published",
        title: result.title ?? result.url,
        payload_text: (result.text ?? "").slice(0, 3000),
        author_name: result.author,
        source_url: result.url,
        occurred_at: result.publishedDate
          ? new Date(result.publishedDate)
          : new Date(),
        metadata: {
          url: result.url,
          author: result.author,
        },
      });
    }

    const allKnown = [...(checkpoint.seen_ids ?? []), ...newIds];
    const trimmed = allKnown.slice(-MAX_DEDUP_IDS);

    return {
      events,
      checkpoint: { seen_ids: trimmed } as unknown as Record<string, unknown>,
      metadata: { items_found: events.length },
    };
  }

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: "Actions not supported" };
  }

  private async search(config: ExaConfig): Promise<ExaResult[]> {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: config.query,
        numResults: config.num_results ?? 20,
        includeDomains: config.include_domains,
        contents: { text: { maxCharacters: 3000 } },
      }),
    });
    if (!response.ok) {
      throw new Error(`Exa ${response.status}: ${response.statusText}`);
    }
    const body = (await response.json()) as { results?: ExaResult[] };
    return body.results ?? [];
  }
}
