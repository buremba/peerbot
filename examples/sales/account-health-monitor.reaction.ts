/**
 * Reaction for the `account-health-monitor` watcher.
 *
 * When the watcher detects a material risk-level change on a tracked account,
 * persist a `health_change` event so the renewal-risk view + weekly digest
 * have a stable record without re-extracting from the CRM stream.
 */
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

const RISK = { enum: ["low", "medium", "high"] };

// Plain JSON Schema (no TypeBox — importing it into a reaction bundle breaks the
// isolate's SDK client proxy). The host validates `ctx.extracted_data` against
// this before the reaction runs, so the handler just reads it with a TS cast.
export const input = {
  type: "object",
  properties: {
    account_changes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          account: { type: "string" },
          previous_risk: RISK,
          current_risk: RISK,
          signals: { type: "array", items: { type: "string" } },
        },
        required: ["account", "previous_risk", "current_risk", "signals"],
      },
    },
  },
  required: [],
};

interface HealthData {
  account_changes?: Array<{
    account: string;
    previous_risk: "low" | "medium" | "high";
    current_risk: "low" | "medium" | "high";
    signals: string[];
  }>;
}

const RISK_ORDER = { low: 0, medium: 1, high: 2 } as const;

export default async (
  ctx: ReactionContext,
  client: ReactionClient
): Promise<void> => {
  const data = ctx.extracted_data as HealthData;
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
