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
  author_name?: string | null;
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

function isReviewableLinkedInPostUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return (
      (host === "linkedin.com" || host.endsWith(".linkedin.com")) &&
      /^\/feed\/update\/urn:li:(?:activity|share|ugcPost):\d+\/?$/i.test(
        url.pathname
      )
    );
  } catch {
    return false;
  }
}

const LINKEDIN_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    outcome: {
      type: "string",
      title: "Outcome",
      enum: ["posted_unchanged", "posted_edited"],
      description:
        "Choose what you actually posted. Use Reject instead if the draft was not relevant or should not be posted.",
    },
    final_text: {
      type: "string",
      title: "Final text (if edited)",
      description:
        "If you changed the comment before posting, paste the final version so future suggestions can learn from the edit.",
      maxLength: 3000,
    },
    note: {
      type: "string",
      title: "Optional note",
      description: "Anything else the system should learn from your choice.",
      maxLength: 1000,
    },
  },
  required: ["outcome"],
} as const;

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
    `SELECT id, author_name, payload_text, source_url, metadata FROM events
     WHERE ${runPredicate}
       AND semantic_type = 'draft_reply'
       AND metadata->>'behavior_output' = 'drafts'
       AND metadata->>'behavior_id' = '${Number(ctx.behavior.id)}'
     ORDER BY id`
  )) as PersistedDraft[];

  const producerKey = producerRunKey(ctx);
  const deliveryNotes: string[] = [];

  const sendDigest = async (
    signals: PersistedSignal[] = deliveredSignals,
    includeDrafts = true
  ): Promise<void> => {
    if (signals.length === 0) return;
    const contentIds = signals.flatMap((signal) => {
      const sourceId = Number(signal.metadata.source_event_id);
      return Number.isInteger(sourceId) && sourceId > 0
        ? [sourceId, signal.id]
        : [signal.id];
    });
    if (includeDrafts) {
      for (const draft of deliveredDrafts) contentIds.push(draft.id);
    }
    const lines = signals.map(
      ({ author_name, metadata }) =>
        `[${metadata.priority ?? "normal"}] ${author_name ?? "Someone"} (${metadata.platform ?? "social"}) — ${metadata.why ?? "New signal"}`
    );
    if (deliveryNotes.length > 0) lines.push("", ...deliveryNotes);
    const body = notificationBody(lines);
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
  };

  if (deliveredDrafts.length === 0) {
    await sendDigest();
    return;
  }

  // This is intentionally a stable, human-selected pairing slug. Never pick an
  // arbitrary online Chrome connection: that can stage a draft in the wrong
  // physical browser or signed-in account.
  // The connections SDK computes device online/offline server-side; raw SQL
  // cannot reach the worker liveness table (not in the queryable allowlist).
  // Page through the list so a large org with many Chrome connections cannot
  // push the pinned browser past the newest-50 default page; a short page is
  // the only terminator, so no arbitrary bound can skip an older browser.
  let browserConnectionId = 0;
  for (let offset = 0; ; offset += 50) {
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
    deliveryNotes.push(
      "Draft not staged: the pinned interactive Chrome is offline."
    );
    await sendDigest();
    return;
  }

  const behaviorSource = {
    behavior_id: ctx.behavior.id,
    window_id: ctx.window.id,
  };
  const reviewedSourceEventIds = new Set<number>();
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
      deliveryNotes.push(
        "Draft not staged: its saved handoff data is incomplete."
      );
      continue;
    }
    if (platform === "linkedin" && !isReviewableLinkedInPostUrl(sourceUrl)) {
      client.log(
        "Saved LinkedIn draft has only the generic feed URL; a durable post permalink is required before staging.",
        { draft_event_id: draft.id, source_url: sourceUrl }
      );
      deliveryNotes.push(
        "LinkedIn draft not staged: the post did not expose a durable link."
      );
      continue;
    }

    let result: Awaited<ReturnType<ReactionClient["operations"]["execute"]>>;
    try {
      result = await client.operations.execute({
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
    } catch (error) {
      client.log(
        "Social draft staging threw; continuing with the signal digest.",
        {
          draft_event_id: draft.id,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      deliveryNotes.push(
        `${draft.metadata.platform === "linkedin" ? "LinkedIn" : "Social"} draft not staged: the browser handoff errored.`
      );
      continue;
    }
    if (result.status !== "completed") {
      client.log(
        "Could not stage the saved social draft in the interactive browser.",
        {
          draft_event_id: draft.id,
          status: result.status,
          error: result.error_message,
        }
      );
      deliveryNotes.push(
        `${platform === "linkedin" ? "LinkedIn" : "X"} draft not staged: the browser handoff failed.`
      );
      continue;
    }

    if (platform === "linkedin") {
      const sourceEventId = Number(draft.metadata.source_event_id);
      const matchingSignal = deliveredSignals.find(
        (signal) => Number(signal.metadata.source_event_id) === sourceEventId
      );
      const author =
        draft.author_name?.trim() ||
        matchingSignal?.author_name?.trim() ||
        "this post";
      const reviewBody = notificationBody([
        "Review the staged comment in LinkedIn. Record what you posted, or use Reject and explain why it was not relevant.",
        "",
        `Why it was suggested: ${draft.metadata.why ?? "Relevant social signal"}`,
        "",
        `Draft: ${body}`,
        "",
        `Post: ${sourceUrl}`,
      ]);
      // Once staging succeeds, review creation is part of the durable contract.
      // Let a transient send failure retry the reaction; both calls are
      // idempotent, so the browser handoff will not be duplicated.
      await client.notifications.send({
        title: `Review LinkedIn comment for ${author}`,
        body: reviewBody,
        recipients: "admins",
        input_schema: LINKEDIN_REVIEW_SCHEMA,
        idempotency_key: `social-radar:review:${draft.id}`,
        behavior_source: behaviorSource,
      });
      if (Number.isSafeInteger(sourceEventId) && sourceEventId > 0) {
        reviewedSourceEventIds.add(sourceEventId);
      }
    }
  }

  // The answerable review replaces the duplicate FYI for that LinkedIn signal,
  // but unrelated signals from the same firing still get the normal digest.
  const unreviewedSignals = deliveredSignals.filter(
    (signal) =>
      !reviewedSourceEventIds.has(Number(signal.metadata.source_event_id))
  );
  await sendDigest(unreviewedSignals, reviewedSourceEventIds.size === 0);
};
