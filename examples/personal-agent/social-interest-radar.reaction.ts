/**
 * Delivery for the Social Interest Radar Behavior.
 *
 * Declared outputs have already persisted and deduplicated the threaded signal
 * and draft events. The reaction notifies from this run's signal rows and
 * stages its single best reply in an explicitly named interactive browser. A
 * later run that re-ranks the same source neither notifies nor opens a tab.
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
          author: { type: "string", minLength: 1 },
          content: { type: "string", minLength: 1 },
          source_url: { type: "string", minLength: 1 },
          parent_event_id: { type: "integer", minimum: 1 },
          idempotency_key: { type: "string", minLength: 1 },
          metadata: {
            type: "object",
            properties: {
              platform: { type: "string" },
              why: { type: "string" },
              priority: {
                type: "string",
                enum: ["low", "normal", "high"],
              },
              source_event_id: { type: "integer", minimum: 1 },
              source_connection_id: { type: "integer", minimum: 1 },
            },
            required: [
              "platform",
              "why",
              "priority",
              "source_event_id",
              "source_connection_id",
            ],
          },
        },
        required: [
          "author",
          "content",
          "source_url",
          "parent_event_id",
          "idempotency_key",
          "metadata",
        ],
      },
    },
    drafts: {
      type: "array",
      maxItems: 1,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          author: { type: "string", minLength: 1 },
          content: { type: "string", minLength: 1 },
          source_url: { type: "string", minLength: 1 },
          parent_event_id: { type: "integer", minimum: 1 },
          idempotency_key: { type: "string", minLength: 1 },
          metadata: {
            type: "object",
            properties: {
              platform: { type: "string", enum: ["x", "linkedin"] },
              why: { type: "string" },
              priority: {
                type: "string",
                enum: ["low", "normal", "high"],
              },
              source_event_id: { type: "integer", minimum: 1 },
              source_connection_id: { type: "integer", minimum: 1 },
            },
            required: [
              "platform",
              "why",
              "priority",
              "source_event_id",
              "source_connection_id",
            ],
          },
        },
        required: [
          "author",
          "content",
          "source_url",
          "parent_event_id",
          "idempotency_key",
          "metadata",
        ],
      },
    },
  },
  required: ["signals", "drafts"],
};

interface PersistedSignal {
  id: number;
  author_name: string | null;
  metadata: {
    platform?: string;
    why?: string;
    priority?: string;
    source_event_id?: number;
  };
}

interface PersistedDraft {
  id: number;
  payload_text: string;
  source_url: string;
  metadata: {
    platform?: string;
    why?: string;
    priority?: string;
    source_event_id?: number;
    source_connection_id?: number;
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
  const extracted = ctx.extracted_data as {
    signals?: unknown[];
    drafts?: unknown[];
  };
  if (
    (extracted.signals?.length ?? 0) === 0 &&
    (extracted.drafts?.length ?? 0) === 0
  ) {
    return;
  }

  const runPredicate =
    ctx.window.run_id != null
      ? `run_id = ${Number(ctx.window.run_id)}`
      : `metadata->>'window_id' = '${Number(ctx.window.id)}'`;
  const deliveredSignals = (await client.query(
    `SELECT id, author_name, metadata FROM events
     WHERE ${runPredicate}
       AND semantic_type = 'observation'
       AND metadata->>'behavior_output' = 'signals'
       AND metadata->>'behavior_id' = '${Number(ctx.behavior.id)}'
     ORDER BY id`
  )) as PersistedSignal[];
  const deliveredDrafts = (await client.query(
    `SELECT id, payload_text, source_url, metadata FROM events
     WHERE ${runPredicate}
       AND semantic_type = 'draft_reply'
       AND metadata->>'behavior_output' = 'drafts'
       AND metadata->>'behavior_id' = '${Number(ctx.behavior.id)}'
     ORDER BY id`
  )) as PersistedDraft[];

  const contentIds = deliveredSignals.flatMap((signal) => {
    const sourceId = Number(signal.metadata.source_event_id);
    return Number.isInteger(sourceId) && sourceId > 0
      ? [sourceId, signal.id]
      : [signal.id];
  });
  for (const draft of deliveredDrafts) contentIds.push(draft.id);
  const body = notificationBody(
    deliveredSignals.map(
      ({ author_name, metadata }) =>
        `[${metadata.priority ?? "normal"}] ${author_name ?? "Someone"} (${metadata.platform ?? "social"}) — ${metadata.why ?? "New signal"}`
    )
  );
  const producerKey = producerRunKey(ctx);

  if (deliveredSignals.length > 0) {
    await client.notifications.send({
      title: "Social interest radar",
      body,
      recipients: "admins",
      resource_url: `/${encodeURIComponent(ctx.organization_slug)}/memory?content_ids=${[
        ...new Set(contentIds),
      ].join(",")}`,
      idempotency_key: `social-radar:notification:${producerKey}`,
      behavior_source: {
        behavior_id: ctx.behavior.id,
        window_id: ctx.window.id,
      },
    });
  }

  if (deliveredDrafts.length === 0) return;

  // This is intentionally a stable, human-selected pairing slug. Never pick an
  // arbitrary online Chrome connection: that can stage a draft in the wrong
  // physical browser or signed-in account.
  // The connections SDK computes device online/offline server-side; raw SQL
  // cannot reach the worker liveness table (not in the queryable allowlist).
  // Page through the list so a large org with many Chrome connections cannot
  // push the pinned browser past the newest-20 default page.
  let browserConnectionId = 0;
  for (let offset = 0; offset < 500; offset += 50) {
    const page = (await client.connections.list({
      connector_key: "chrome",
      status: "active",
      limit: 50,
      offset,
    })) as {
      connections?: Array<{
        id?: unknown;
        slug?: string;
        device_online?: boolean;
      }>;
    };
    const browser = (page?.connections ?? []).find(
      (c) => c.slug === "chrome-macbook" && c.device_online === true
    );
    if (browser) {
      browserConnectionId = Number(browser.id);
      break;
    }
    if ((page?.connections?.length ?? 0) < 50) break;
  }
  if (!Number.isSafeInteger(browserConnectionId) || browserConnectionId <= 0) {
    client.log(
      "Interactive browser 'chrome-macbook' is not online; draft event was saved but no browser was guessed."
    );
    return;
  }

  const behaviorSource = {
    behavior_id: ctx.behavior.id,
    window_id: ctx.window.id,
  };
  for (const draft of deliveredDrafts) {
    const connectionId = Number(draft.metadata.source_connection_id);
    const body = draft.payload_text?.trim();
    const sourceUrl = draft.source_url?.trim();
    const platform = draft.metadata.platform;
    if (
      !Number.isSafeInteger(connectionId) ||
      connectionId <= 0 ||
      !body ||
      !sourceUrl ||
      (platform !== "x" && platform !== "linkedin")
    ) {
      client.log(
        "Saved social draft is missing a valid source connection, URL, or body.",
        {
          draft_event_id: draft.id,
        }
      );
      continue;
    }

    const result = await client.operations.execute({
      connection_id: connectionId,
      operation_key: platform === "x" ? "prepare_reply" : "prepare_comment",
      idempotency_key: `social-radar:draft:${draft.id}`,
      input:
        platform === "x"
          ? {
              tweet_url: sourceUrl,
              body,
              reason: draft.metadata.why,
              browser_connection_id: browserConnectionId,
            }
          : {
              post_url: sourceUrl,
              body,
              reason: draft.metadata.why,
              browser_connection_id: browserConnectionId,
            },
      behavior_source: behaviorSource,
    });
    if (result.status !== "completed") {
      client.log(
        "Could not stage the saved social draft in the interactive browser.",
        {
          draft_event_id: draft.id,
          status: result.status,
          error: result.error_message,
        }
      );
    }
  }
};
