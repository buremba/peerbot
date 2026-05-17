/**
 * Reaction for the `reconciliation-monitor` watcher.
 *
 * Persists any variance flagged during the daily 6am sweep as a durable
 * `variance_flag` event tied to the affected account. Downstream agents
 * (close-of-month rollup, audit prep) consume these events instead of
 * re-extracting variances from the raw transaction stream.
 */
import type { ReactionContext } from "@lobu/connector-sdk";

interface ReconciliationData {
  variances?: Array<{
    account: string;
    amount: number;
    direction: "over" | "under";
    reason: string;
  }>;
  unreconciled_count?: number;
}

export default async (ctx: ReactionContext, client: any): Promise<void> => {
  const data = ctx.extracted_data as ReconciliationData;
  const variances = data.variances ?? [];
  if (variances.length === 0) return;

  for (const v of variances) {
    await client.knowledge.save({
      entity_ids: ctx.entities.map((e) => e.id),
      content: `Variance ${v.direction} on ${v.account}: ${v.amount} — ${v.reason}`,
      semantic_type: "variance_flag",
      metadata: {
        account: v.account,
        amount: v.amount,
        direction: v.direction,
        window_id: ctx.window.id,
        unreconciled_count: data.unreconciled_count ?? null,
      },
    });
  }
};
