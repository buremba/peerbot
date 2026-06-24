/**
 * Reaction for the `inbound-triage` watcher.
 *
 * Fires every 2h after the watcher LLM extracts new and enriched leads from
 * GitHub/X/HN signals. Persists an `observation` event (tagged `metadata.kind:
 * "lead_interaction"`) per run so the next digest can count them, and — when
 * the run is notable — pushes the recommended
 * actions to the team via `client.notifications.send` (fans out to the #leads
 * Slack connection + the in-app inbox).
 */
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

// Plain JSON Schema (no TypeBox — importing it into a reaction bundle breaks the
// isolate's SDK client proxy). The host validates `ctx.extracted_data` against
// this before the reaction runs, so the handler just reads it with a TS cast.
export const input = {
  type: "object",
  properties: {
    new_leads: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          source: { type: "string" },
          stage: { type: "string" },
          why: { type: "string" },
        },
        required: ["name", "source", "stage"],
      },
    },
    recommended_actions: { type: "array", items: { type: "string" } },
    notable: { type: "boolean" },
  },
  required: [],
};

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

export default async (
  ctx: ReactionContext,
  client: ReactionClient
): Promise<void> => {
  const data = ctx.extracted_data as TriageData;
  if (!data.notable) return;

  const actions = data.recommended_actions ?? [];
  if (actions.length === 0) return;

  const summary = [
    `Triage run ${ctx.window.window_end.slice(0, 16)} — ${actions.length} action(s)`,
    ...actions.map((a, i) => `${i + 1}. ${a}`),
  ].join("\n");

  await client.knowledge.save({
    entity_ids: ctx.entities.map((e) => e.id),
    content: summary,
    // `semantic_type` must be a registered event kind; "observation" fits a
    // triage note. The domain label lives in metadata so it stays queryable.
    semantic_type: "observation",
    metadata: {
      kind: "lead_interaction",
      window_id: ctx.window.id,
      new_lead_count: data.new_leads?.length ?? 0,
      action_count: actions.length,
    },
  });

  await client.notifications.send({
    title: `Inbound triage — ${actions.length} action(s), ${data.new_leads?.length ?? 0} new lead(s)`,
    body: summary,
    watcher_source: {
      watcher_id: ctx.window.watcher_id,
      window_id: ctx.window.id,
    },
  });
};
