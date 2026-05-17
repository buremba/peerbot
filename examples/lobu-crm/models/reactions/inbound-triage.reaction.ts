/**
 * Reaction for the `inbound-triage` watcher.
 *
 * Fires every 2h after the watcher LLM extracts new and enriched leads from
 * GitHub/X/HN signals. The script writes a `lead_interaction` event per
 * recommended action so the next digest can count them — the watcher itself
 * already creates the `lead` rows, so we don't duplicate that here.
 */
import type { ReactionContext } from "@lobu/connector-sdk";

interface TriageData {
  new_leads?: Array<{
    name: string;
    source: string;
    stage: string;
    why?: string;
  }>;
  recommended_actions?: string[];
  notable?: boolean;
}

export default async (ctx: ReactionContext, client: any): Promise<void> => {
  const data = ctx.extracted_data as TriageData;
  // Nothing notable → nothing to persist. The watcher's prompt is explicit
  // about not manufacturing noise; we mirror that here.
  if (!data.notable) return;

  const actions = data.recommended_actions ?? [];
  if (actions.length === 0) return;

  await client.knowledge.save({
    entity_ids: ctx.entities.map((e) => e.id),
    content: [
      `Triage run ${ctx.window.window_end.slice(0, 16)} — ${actions.length} action(s)`,
      ...actions.map((a, i) => `${i + 1}. ${a}`),
    ].join("\n"),
    semantic_type: "lead_interaction",
    metadata: {
      window_id: ctx.window.id,
      new_lead_count: data.new_leads?.length ?? 0,
      action_count: actions.length,
    },
  });
};
