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
import {
  Type,
  type Static,
  Value,
  type ReactionClient,
  type ReactionContext,
} from "@lobu/connector-sdk";

const input = Type.Object({
  new_leads: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        source: Type.String(),
        stage: Type.String(),
        why: Type.Optional(Type.String()),
      })
    )
  ),
  recommended_actions: Type.Optional(Type.Array(Type.String())),
  notable: Type.Optional(Type.Boolean()),
});
type TriageData = Static<typeof input>;

export default async (
  ctx: ReactionContext,
  client: ReactionClient
): Promise<void> => {
  const data: TriageData = Value.Parse(input, ctx.extracted_data);
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
