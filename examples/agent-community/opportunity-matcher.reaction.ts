/**
 * Reaction for the `opportunity-matcher` watcher.
 *
 * Runs every 12h after the LLM scans member activity and produces a list of
 * suggested matches. Persists each match as a `community_match` event so
 * downstream consumers (intro-drafting agents, weekly digest, audit log) can
 * iterate over a single source of truth instead of re-running the matcher.
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
        member_a: Type.String(),
        member_b: Type.String(),
        reason: Type.String(),
        confidence: Type.Optional(Type.Number()),
      })
    )
  ),
});
type MatchData = Static<typeof input>;

export default async (ctx: ReactionContext, client: any): Promise<void> => {
  const data: MatchData = Value.Parse(input, ctx.extracted_data);
  const signals = data.signals ?? [];
  if (signals.length === 0) return;

  for (const s of signals) {
    await client.knowledge.save({
      entity_ids: ctx.entities.map((e) => e.id),
      content: `Match: ${s.member_a} ↔ ${s.member_b} — ${s.reason}`,
      semantic_type: "community_match",
      metadata: {
        member_a: s.member_a,
        member_b: s.member_b,
        confidence: s.confidence ?? null,
        window_id: ctx.window.id,
      },
    });
  }
};
