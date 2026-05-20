/**
 * Reaction for the `daily-summary` watcher.
 *
 * This runs AFTER the watcher's LLM has extracted structured data.
 * `ctx.extracted_data` is the JSON matching the `extraction_schema` in schema.yaml.
 *
 * The `client` gives you:
 *   client.knowledge.save({...})    — write a new event to the knowledge graph
 *   client.knowledge.search({...})  — search existing events
 *   client.entities.create({...})   — create/update entities
 *   client.entities.list({...})     — query entities
 *
 * @param ctx   — watcher context (extracted data, entities, window metadata)
 * @param client — Lobu API client for reading/writing the knowledge graph
 */
import type { ReactionContext } from "@lobu/connector-sdk";

interface TopicSummary {
  name: string;
  summary: string;
  importance: "low" | "medium" | "high";
}

interface DailySummaryData {
  topics: TopicSummary[];
}

export default async (ctx: ReactionContext, client: any): Promise<void> => {
  const data = ctx.extracted_data as DailySummaryData;

  if (data.topics.length === 0) return;

  // Persist each topic as a knowledge event so the agent can cite it later.
  await client.knowledge.save({
    entity_ids: ctx.entities.map((e) => e.id),
    content: data.topics
      .map((t) => `**${t.name}** (${t.importance}): ${t.summary}`)
      .join("\n"),
    semantic_type: "daily_digest",
    metadata: {
      window_id: ctx.window.id,
      topic_count: data.topics.length,
      high_importance: data.topics.filter((t) => t.importance === "high").length,
    },
  });
};
