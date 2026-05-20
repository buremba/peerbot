/**
 * Reaction for the `reconciliation-monitor` watcher.
 *
 * Persists variance events when unreconciled transactions or new anomalies
 * are detected during the daily reconciliation pass.
 */
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

interface ReconciliationData {
  unreconciled_count: number;
  new_variances: string[];
  approaching_deadlines: string[];
  payment_risks?: string[];
}

export default async (
  ctx: ReactionContext,
  client: ReactionClient
): Promise<void> => {
  const data = ctx.extracted_data as ReconciliationData;

  const hasIssues =
    data.unreconciled_count > 0 ||
    (data.new_variances?.length ?? 0) > 0 ||
    (data.approaching_deadlines?.length ?? 0) > 0;

  if (!hasIssues) return;

  const parts: string[] = [];
  if (data.unreconciled_count > 0) {
    parts.push(`${data.unreconciled_count} unreconciled transactions`);
  }
  if (data.new_variances?.length) {
    parts.push(`Variances: ${data.new_variances.join("; ")}`);
  }
  if (data.approaching_deadlines?.length) {
    parts.push(`Deadlines: ${data.approaching_deadlines.join("; ")}`);
  }

  await client.knowledge.save({
    entity_ids: ctx.entities.map((e) => e.id),
    content: parts.join("\n"),
    semantic_type: "reconciliation_alert",
    metadata: {
      window_id: ctx.window.id,
      unreconciled_count: data.unreconciled_count,
      variance_count: data.new_variances?.length ?? 0,
    },
  });
};
