/**
 * Delivery for the Social Interest Radar Behavior.
 *
 * Declared outputs have already persisted and deduplicated the threaded signal
 * and draft events. The reaction notifies from this run's signal rows and
 * schedules its single best reply for activation when the user visits that
 * exact post. A later run that re-ranks the same source neither notifies nor
 * opens a tab.
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

function notificationBody(lines: string[]): string {
  const body = lines.join("\n");
  return body.length <= 1000 ? body : `${body.slice(0, 997)}...`;
}

/**
 * Normalize an HN item URL/id to its canonical item-page URL
 * (`/item?id=`). HN's story comment box lives on the item page; the
 * /reply?id= page only serves individual comment replies.
 */
function hnItemUrl(value: string): string {
  const match = value.match(/\/item\?id=(\d+)/) ?? value.match(/(\d{4,})/);
  const id = match?.[1];
  return id ? `https://news.ycombinator.com/item?id=${id}` : value;
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

  const deliveryNotes: string[] = [];

  // Only draft-ready notifications are delivered. The "everything I noticed"
  // digest added a raw timeline dump (source tweets + signals) as a second
  // notification; the draft-ready cards already surface the curated, actionable
  // items, so a run with no drafts notifies nothing.
  if (deliveredDrafts.length === 0) {
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
      (platform !== "x" && platform !== "linkedin" && platform !== "hackernews")
    ) {
      client.log(
        "Saved social draft is missing a valid source connection, URL, or body.",
        {
          draft_event_id: draft.id,
        }
      );
      deliveryNotes.push(
        "Draft not scheduled: its saved handoff data is incomplete."
      );
      continue;
    }
    if (platform === "linkedin" && !isReviewableLinkedInPostUrl(sourceUrl)) {
      client.log(
        "Saved LinkedIn draft has only the generic feed URL; a durable post permalink is required before scheduling.",
        { draft_event_id: draft.id, source_url: sourceUrl }
      );
      deliveryNotes.push(
        "LinkedIn draft not scheduled: the post did not expose a durable link."
      );
      continue;
    }

    let result: Awaited<ReturnType<ReactionClient["operations"]["execute"]>>;
    try {
      // HN's story comment box lives on the item page, so the activation
      // target + browser_url must be that item URL — the user clicks the
      // notification and lands on the page where the comment box is.
      const targetUrl =
        platform === "hackernews" ? hnItemUrl(sourceUrl) : sourceUrl;
      const input =
        platform === "x"
          ? {
              tweet_url: sourceUrl,
              body,
              reason: draft.metadata.why,
            }
          : platform === "hackernews"
            ? {
                item_url: targetUrl,
                body,
              }
            : {
                post_url: sourceUrl,
                body,
                reason: draft.metadata.why,
              };
      result = await client.operations.execute({
        connection_id: connectionId,
        operation_key: platform === "x" ? "prepare_reply" : "prepare_comment",
        idempotency_key: `social-radar:draft:${draft.id}`,
        input,
        activation: {
          kind: "page_visit",
          urls: [targetUrl],
          expires_in_seconds: 86_400,
        },
        behavior_source: behaviorSource,
      });
    } catch (error) {
      client.log(
        "Social draft scheduling threw; retrying the reaction because the durable operation may already exist.",
        {
          draft_event_id: draft.id,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      throw error;
    }
    if (result.status !== "in_progress" && result.status !== "completed") {
      client.log(
        "Could not schedule the saved social draft for page activation.",
        {
          draft_event_id: draft.id,
          status: result.status,
          error: result.error_message,
        }
      );
      deliveryNotes.push(
        `${platform === "linkedin" ? "LinkedIn" : platform === "hackernews" ? "Hacker News" : "X"} draft not scheduled.`
      );
      continue;
    }

    const sourceEventId = Number(draft.metadata.source_event_id);
    const matchingSignal = deliveredSignals.find(
      (signal) => Number(signal.metadata.source_event_id) === sourceEventId
    );
    const author =
      draft.author_name?.trim() ||
      matchingSignal?.author_name?.trim() ||
      "this post";
    await client.notifications.send({
      title: `Draft ready for ${author} on ${platform === "x" ? "X" : platform === "hackernews" ? "Hacker News" : "LinkedIn"}`,
      body: notificationBody([
        `Why: ${draft.metadata.why ?? "Relevant social signal"}`,
        "",
        `Draft: ${body}`,
        "",
        "Open the post in Chrome and Lobu will place this draft in the composer. You still choose whether to post it.",
      ]),
      recipients: "admins",
      resource_url: `/${encodeURIComponent(ctx.organization_slug)}/memory?content_ids=${[
        sourceEventId,
        draft.id,
      ]
        .filter((id) => Number.isSafeInteger(id) && id > 0)
        .join(",")}`,
      browser_url:
        platform === "hackernews" ? hnItemUrl(sourceUrl) : sourceUrl,
      idempotency_key: `social-radar:draft-ready:${draft.id}`,
      behavior_source: behaviorSource,
    });
  }
};
