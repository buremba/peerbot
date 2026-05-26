/**
 * Reaction for the `funnel-digest` watcher.
 *
 * Runs after the weekly Monday-9am window completes. `ctx.extracted_data` is
 * whatever the watcher's `extraction_schema` produced — funnel snapshot, top
 * action, stale leads, etc. We:
 *   1. persist the digest as a `summary` event (tagged `metadata.kind:
 *      "funnel_digest"`) linked to every lead the watcher knows about, so the
 *      next digest can compare stage_counts week-over-week without re-running
 *      classification; and
 *   2. push it to the team via `client.notifications.send` — which fans out to
 *      the org's active bot connections (the #leads Slack connection) and the
 *      in-app inbox. `watcher_source` attributes it to this window.
 */
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

interface DigestData {
  top_action?: string;
  stage_counts?: Record<string, number>;
  conversations_this_week?: number;
  gap?: string;
}

export default async (
  ctx: ReactionContext,
  client: ReactionClient
): Promise<void> => {
  const data = ctx.extracted_data as DigestData;
  const stageSummary = Object.entries(data.stage_counts ?? {})
    .map(([stage, n]) => `${stage}: ${n}`)
    .join(", ");
  const content = [
    `Weekly funnel digest — ${ctx.window.window_end.slice(0, 10)}`,
    `Top action: ${data.top_action ?? "(none)"}`,
    `Stages: ${stageSummary || "(empty)"}`,
    `Conversations this week: ${data.conversations_this_week ?? 0}`,
    data.gap ? `Gap: ${data.gap}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  await client.knowledge.save({
    // Attaching to the whole watcher's entity set keeps the digest scoped to
    // CRM data and discoverable from any lead the watcher already touches.
    entity_ids: ctx.entities.map((e) => e.id),
    content,
    // `semantic_type` must be a registered event kind; "summary" fits a digest.
    // The domain label lives in metadata so it stays queryable.
    semantic_type: "summary",
    metadata: {
      kind: "funnel_digest",
      window_id: ctx.window.id,
      watcher_slug: ctx.watcher.slug,
      stage_counts: data.stage_counts ?? {},
      top_action: data.top_action ?? null,
    },
  });

  await client.notifications.send({
    title: `Weekly funnel digest — ${ctx.window.window_end.slice(0, 10)}`,
    body: content,
    watcher_source: {
      watcher_id: ctx.window.watcher_id,
      window_id: ctx.window.id,
    },
  });
};
