/**
 * Reaction for the `daily-summary` watcher.
 *
 * This runs AFTER the watcher's LLM fills the `extraction_schema` from schema.yaml.
 * `ctx.extracted_data` is the typed JSON the LLM produced.
 * `client` dispatches calls to the Lobu knowledge graph and entity store.
 *
 * Signature: export default async (ctx, client, params?) => void
 */
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

interface TopicSummary {
  name: string;
  summary: string;
  importance: "low" | "medium" | "high";
}

interface DailySummaryData {
  topics: TopicSummary[];
}

export default async (
  ctx: ReactionContext,
  client: ReactionClient,
): Promise<void> => {
  const data = ctx.extracted_data as DailySummaryData;

  if (data.topics.length === 0) return;

  await client.knowledge.save({
    entity_ids: ctx.entities.map((e) => e.id),
    content: data.topics
      .map((t) => `**${t.name}** (${t.importance}): ${t.summary}`)
      .join("\n"),
    semantic_type: "daily_digest",
    metadata: {
      window_id: ctx.window.id,
      topic_count: data.topics.length,
      high_importance: data.topics.filter((t) => t.importance === "high")
        .length,
    },
  });
};
