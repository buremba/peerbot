/**
 * Reaction for the `account-health-monitor` watcher.
 *
 * When the watcher detects a material risk-level change on a tracked account,
 * persist a `health_change` event so the renewal-risk view + weekly digest
 * have a stable record without re-extracting from the CRM stream.
 */
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

const RISK = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
]);
export const input = Type.Object({
  account_changes: Type.Optional(
    Type.Array(
      Type.Object({
        account: Type.String(),
        previous_risk: RISK,
        current_risk: RISK,
        signals: Type.Array(Type.String()),
      })
    )
  ),
});
type HealthData = Static<typeof input>;

const RISK_ORDER = { low: 0, medium: 1, high: 2 } as const;

export default async (
  ctx: ReactionContext,
  client: ReactionClient
): Promise<void> => {
  const data: HealthData = Value.Parse(input, ctx.extracted_data);
  const changes = data.account_changes ?? [];
  const escalations = changes.filter(
    (c) => RISK_ORDER[c.current_risk] > RISK_ORDER[c.previous_risk]
  );
  if (escalations.length === 0) return;

  for (const c of escalations) {
    await client.knowledge.save({
      entity_ids: ctx.entities.map((e) => e.id),
      content: `Account ${c.account}: risk ${c.previous_risk} → ${c.current_risk}\nSignals: ${c.signals.join("; ")}`,
      semantic_type: "health_change",
      metadata: {
        account: c.account,
        from: c.previous_risk,
        to: c.current_risk,
        window_id: ctx.window.id,
      },
    });
  }
};
