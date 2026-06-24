/**
 * Reaction for atlas's `catalog-staleness-checker` watcher.
 *
 * Writes a `catalog_stale` event per stale entry the LLM identified. Atlas is
 * a long-lived reference catalog — entries that haven't been re-verified in
 * 90+ days are flagged so a curator can decide whether to refresh, retire, or
 * leave them.
 */
import type { ReactionContext } from "@lobu/connector-sdk";

// Plain JSON Schema (no TypeBox — importing it into a reaction bundle breaks the
// isolate's SDK client proxy). The host validates `ctx.extracted_data` against
// this before the reaction runs, so the handler just reads it with a TS cast.
export const input = {
  type: "object",
  properties: {
    stale_entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          entity_type: { type: "string" },
          slug: { type: "string" },
          last_updated: { type: "string" },
          suggested_action: { type: "string" },
        },
        required: ["entity_type", "slug", "last_updated", "suggested_action"],
      },
    },
  },
  required: [],
};

interface StaleData {
  stale_entries?: Array<{
    entity_type: string;
    slug: string;
    last_updated: string;
    suggested_action: string;
  }>;
}

export default async (ctx: ReactionContext, client: any): Promise<void> => {
  const data = ctx.extracted_data as StaleData;
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
