/**
 * Deterministic delivery for the Social Interest Radar Behavior.
 *
 * The model ranks posts and explains why they matter. This reaction owns every
 * durable side effect: one reply event per source post, followed by one digest
 * notification linking to the source/reply threads. Both writes carry durable
 * idempotency keys because the reaction executor retries a failed script.
 */
import type {
  KnowledgeSaveResult,
  ReactionClient,
  ReactionContext,
} from "@lobu/connector-sdk";

export const input = {
  type: "object",
  properties: {
    digest_title: { type: "string", minLength: 1, maxLength: 200 },
    analysis_summary: { type: "string" },
    items: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          platform: { enum: ["x", "linkedin"] },
          author: { type: "string", minLength: 1 },
          snippet: { type: "string" },
          why: { type: "string", minLength: 1 },
          priority: { enum: ["high", "normal", "low"] },
          source_origin_id: { type: "string", minLength: 1 },
          source_event_id: { type: "integer", minimum: 1 },
          suggested_action: { type: "string", minLength: 1 },
        },
        required: [
          "platform",
          "author",
          "snippet",
          "why",
          "priority",
          "source_origin_id",
          "source_event_id",
          "suggested_action",
        ],
      },
    },
  },
  required: ["digest_title", "analysis_summary", "items"],
};

interface RadarItem {
  platform: "x" | "linkedin";
  author: string;
  snippet: string;
  why: string;
  priority: "high" | "normal" | "low";
  source_origin_id: string;
  source_event_id: number;
  suggested_action: string;
}

interface RadarOutput {
  digest_title: string;
  analysis_summary: string;
  items: RadarItem[];
}

function producerRunKey(ctx: ReactionContext): string {
  return ctx.window.run_id != null
    ? `run:${ctx.window.run_id}`
    : `window:${ctx.window.id}:version:${ctx.behavior.version}`;
}

function belongsToProducer(
  result: KnowledgeSaveResult,
  producerKey: string
): boolean {
  return result.created || result.metadata.producer_run_key === producerKey;
}

function notificationBody(lines: string[]): string {
  const body = lines.join("\n");
  return body.length <= 1000 ? body : `${body.slice(0, 997)}...`;
}

export default async (
  ctx: ReactionContext,
  client: ReactionClient
): Promise<void> => {
  const output = ctx.extracted_data as unknown as RadarOutput;
  if (output.items.length === 0) return;

  const producerKey = producerRunKey(ctx);
  const delivered: Array<{ item: RadarItem; replyId: number }> = [];

  for (const item of output.items) {
    const reply = await client.knowledge.save({
      content: [
        item.why,
        "",
        `Suggested action: ${item.suggested_action}`,
      ].join("\n"),
      title: `${item.author} on ${item.platform}`,
      author: "personal-agent",
      semantic_type: "social_signal",
      payload_type: "markdown",
      parent_event_id: item.source_event_id,
      idempotency_key: `social-radar:source:${item.source_origin_id}`,
      metadata: {
        ...item,
        producer_run_key: producerKey,
        behavior_id: ctx.behavior.id,
        window_id: ctx.window.id,
      },
      behavior_source: {
        behavior_id: ctx.behavior.id,
        window_id: ctx.window.id,
      },
    });

    // A later Behavior run may rank the same post again. knowledge.save returns
    // its original event, but only the run that first created it should notify.
    // A retry of THAT run still qualifies through the stored producer key.
    if (belongsToProducer(reply, producerKey)) {
      delivered.push({ item, replyId: reply.id });
    }
  }

  if (delivered.length === 0) return;

  const contentIds = delivered.flatMap(({ item, replyId }) => [
    item.source_event_id,
    replyId,
  ]);
  const resourceUrl = `/${encodeURIComponent(ctx.organization_slug)}/memory?content_ids=${contentIds.join(",")}`;
  const body = notificationBody(
    delivered.map(
      ({ item }) =>
        `[${item.priority}] ${item.author} (${item.platform}) — ${item.why}`
    )
  );

  await client.notifications.send({
    title: output.digest_title,
    body,
    recipients: "admins",
    resource_url: resourceUrl,
    idempotency_key: `social-radar:notification:${producerKey}`,
    behavior_source: {
      behavior_id: ctx.behavior.id,
      window_id: ctx.window.id,
    },
  });
};
