/**
 * Reaction for the `funnel-digest` watcher.
 *
 * Runs after the weekly Monday-9am window completes. `ctx.extracted_data` is
 * whatever the watcher's `extraction_schema` produced — funnel snapshot, top
 * action, stale leads, etc. We persist the digest as a `funnel_digest` event
 * linked to every lead the watcher knows about so the next digest can compare
 * stage_counts week-over-week without re-running classification.
 *
 * Pair with `notification_priority: high` on the watcher — the OS notification
 * fires regardless of whether this script succeeds; this just produces durable
 * knowledge.
 */
import type { ReactionContext } from "@lobu/connector-sdk";

interface DigestData {
  top_action?: string;
  stage_counts?: Record<string, number>;
  conversations_this_week?: number;
  gap?: string;
}

export default async (ctx: ReactionContext, client: any): Promise<void> => {
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
    semantic_type: "funnel_digest",
    metadata: {
      window_id: ctx.window.id,
      watcher_slug: ctx.watcher.slug,
      stage_counts: data.stage_counts ?? {},
      top_action: data.top_action ?? null,
    },
  });
};
