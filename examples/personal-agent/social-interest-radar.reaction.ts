/**
 * Notification-only delivery for the Social Interest Radar Behavior.
 *
 * The declared `signals` output has already persisted and deduplicated the
 * threaded observation events. Querying this run's persisted rows means a
 * later run that re-ranks an old source does not notify twice, while a retry of
 * the original run can safely retry the idempotent notification.
 */
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

export const input = {
  type: "object",
  properties: {
    signals: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          content: { type: "string", minLength: 1 },
          parent_event_id: { type: "integer", minimum: 1 },
          idempotency_key: { type: "string", minLength: 1 },
          metadata: {
            type: "object",
            properties: {
              platform: { type: "string" },
              author: { type: "string" },
              why: { type: "string" },
              priority: {
                type: "string",
                enum: ["low", "normal", "high"],
              },
              source_event_id: { type: "integer", minimum: 1 },
            },
            required: ["platform", "author", "why", "priority"],
          },
        },
        required: ["content", "parent_event_id", "idempotency_key", "metadata"],
      },
    },
  },
  required: ["signals"],
};

interface PersistedSignal {
  id: number;
  metadata: {
    platform?: string;
    author?: string;
    why?: string;
    priority?: string;
    source_event_id?: number;
  };
}

function producerRunKey(ctx: ReactionContext): string {
  return ctx.window.run_id != null
    ? `run:${ctx.window.run_id}`
    : `window:${ctx.window.id}:version:${ctx.behavior.version}`;
}

function notificationBody(lines: string[]): string {
  const body = lines.join("\n");
  return body.length <= 1000 ? body : `${body.slice(0, 997)}...`;
}

export default async (
  ctx: ReactionContext,
  client: ReactionClient
): Promise<void> => {
  const drafts = (ctx.extracted_data as { signals?: unknown[] }).signals ?? [];
  if (drafts.length === 0) return;

  const runPredicate =
    ctx.window.run_id != null
      ? `run_id = ${Number(ctx.window.run_id)}`
      : `metadata->>'window_id' = '${Number(ctx.window.id)}'`;
  const delivered = (await client.query(
    `SELECT id, metadata FROM events
     WHERE ${runPredicate}
       AND semantic_type = 'observation'
       AND metadata->>'behavior_output' = 'signals'
       AND metadata->>'behavior_id' = '${Number(ctx.behavior.id)}'
     ORDER BY id`
  )) as PersistedSignal[];
  if (delivered.length === 0) return;

  const contentIds = delivered.flatMap((signal) => {
    const sourceId = Number(signal.metadata.source_event_id);
    return Number.isInteger(sourceId) && sourceId > 0
      ? [sourceId, signal.id]
      : [signal.id];
  });
  const body = notificationBody(
    delivered.map(
      ({ metadata }) =>
        `[${metadata.priority ?? "normal"}] ${metadata.author ?? "Someone"} (${metadata.platform ?? "social"}) — ${metadata.why ?? "New signal"}`
    )
  );
  const producerKey = producerRunKey(ctx);

  await client.notifications.send({
    title: "Social interest radar",
    body,
    recipients: "admins",
    resource_url: `/${encodeURIComponent(ctx.organization_slug)}/memory?content_ids=${contentIds.join(",")}`,
    idempotency_key: `social-radar:notification:${producerKey}`,
    behavior_source: {
      behavior_id: ctx.behavior.id,
      window_id: ctx.window.id,
    },
  });
};
