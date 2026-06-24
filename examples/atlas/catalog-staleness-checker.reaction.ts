/**
 * Reaction for atlas's `catalog-staleness-checker` watcher.
 *
 * Writes a `catalog_stale` event per stale entry the LLM identified. Atlas is
 * a long-lived reference catalog — entries that haven't been re-verified in
 * 90+ days are flagged so a curator can decide whether to refresh, retire, or
 * leave them.
 */
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ReactionContext } from "@lobu/connector-sdk";

export const input = Type.Object({
  stale_entries: Type.Optional(
    Type.Array(
      Type.Object({
        entity_type: Type.String(),
        slug: Type.String(),
        last_updated: Type.String(),
        suggested_action: Type.String(),
      })
    )
  ),
});
type StaleData = Static<typeof input>;

export default async (ctx: ReactionContext, client: any): Promise<void> => {
  const data: StaleData = Value.Parse(input, ctx.extracted_data);
  const stale = data.stale_entries ?? [];
  if (stale.length === 0) return;

  for (const s of stale) {
    await client.knowledge.save({
      entity_ids: ctx.entities.map((e) => e.id),
      content: `Stale ${s.entity_type}/${s.slug} — last updated ${s.last_updated}\n→ ${s.suggested_action}`,
      semantic_type: "catalog_stale",
      metadata: {
        entity_type: s.entity_type,
        slug: s.slug,
        last_updated: s.last_updated,
        window_id: ctx.window.id,
      },
    });
  }
};
