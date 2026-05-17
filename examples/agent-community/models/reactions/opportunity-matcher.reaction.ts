/**
 * Reaction for the `opportunity-matcher` watcher.
 *
 * Runs every 12h after the LLM scans member activity and produces a list of
 * suggested matches. Persists each match as a `community_match` event so
 * downstream consumers (intro-drafting agents, weekly digest, audit log) can
 * iterate over a single source of truth instead of re-running the matcher.
 */
import type { ReactionContext } from "@lobu/connector-sdk";

interface MatchData {
  signals?: Array<{
    member_a: string;
    member_b: string;
    reason: string;
    confidence?: number;
  }>;
}

export default async (ctx: ReactionContext, client: any): Promise<void> => {
  const data = ctx.extracted_data as MatchData;
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
