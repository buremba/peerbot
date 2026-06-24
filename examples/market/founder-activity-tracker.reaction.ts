/**
 * Reaction for the `founder-activity-tracker` watcher.
 *
 * Records notable public activity (tweets, blog posts, hiring posts, fundraise
 * rumors) as `founder_activity` events. The opportunity-matcher watcher reads
 * these events to suggest cross-portfolio introductions.
 */
import type { ReactionContext } from "@lobu/connector-sdk";

// Plain JSON Schema (no TypeBox — importing it into a reaction bundle breaks the
// isolate's SDK client proxy). The host validates `ctx.extracted_data` against
// this before the reaction runs, so the handler just reads it with a TS cast.
export const input = {
  type: "object",
  properties: {
    signals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          founder: { type: "string" },
          activity_type: { type: "string" },
          summary: { type: "string" },
          importance: { enum: ["low", "medium", "high"] },
        },
        required: ["founder", "activity_type", "summary"],
      },
    },
  },
  required: [],
};

interface FounderActivityData {
  signals?: Array<{
    founder: string;
    activity_type: string;
    summary: string;
    importance?: "low" | "medium" | "high";
  }>;
}

export default async (ctx: ReactionContext, client: any): Promise<void> => {
  const data = ctx.extracted_data as FounderActivityData;
  const signals = data.signals ?? [];
  // High-importance only — low-noise channel for the intel feed.
  const notable = signals.filter((s) => s.importance === "high");
  if (notable.length === 0) return;

  for (const s of notable) {
    await client.knowledge.save({
      entity_ids: ctx.entities.map((e) => e.id),
      content: `${s.founder} — ${s.activity_type}: ${s.summary}`,
      semantic_type: "founder_activity",
      metadata: {
        founder: s.founder,
        activity_type: s.activity_type,
        importance: s.importance,
        window_id: ctx.window.id,
      },
    });
  }
};
