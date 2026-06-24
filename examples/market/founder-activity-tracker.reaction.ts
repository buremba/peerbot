/**
 * Reaction for the `founder-activity-tracker` watcher.
 *
 * Records notable public activity (tweets, blog posts, hiring posts, fundraise
 * rumors) as `founder_activity` events. The opportunity-matcher watcher reads
 * these events to suggest cross-portfolio introductions.
 */
import {
  Type,
  type Static,
  Value,
  type ReactionContext,
} from "@lobu/connector-sdk";

const input = Type.Object({
  signals: Type.Optional(
    Type.Array(
      Type.Object({
        founder: Type.String(),
        activity_type: Type.String(),
        summary: Type.String(),
        importance: Type.Optional(
          Type.Union([
            Type.Literal("low"),
            Type.Literal("medium"),
            Type.Literal("high"),
          ])
        ),
      })
    )
  ),
});
type FounderActivityData = Static<typeof input>;

export default async (ctx: ReactionContext, client: any): Promise<void> => {
  const data: FounderActivityData = Value.Parse(input, ctx.extracted_data);
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
