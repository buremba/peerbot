/**
 * Delivery for the Social Interest Radar Automation.
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
              platform: {
                type: "string",
                enum: ["x", "linkedin", "hackernews"],
              },
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
 * Normalize an HN item URL/id to its canonical item-page URL (`/item?id=`).
 * HN's story comment box lives on the item page. Only rewrites a genuine HN
 * item URL or a bare numeric id; any other URL is returned unchanged so a
 * mislabeled draft can never be pointed at an unrelated HN story.
 */
export function hnItemUrl(value: string): string {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return `https://news.ycombinator.com/item?id=${trimmed}`;
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "news.ycombinator.com") return value;
    const id = url.searchParams.get("id");
    if (id && /^\d+$/.test(id)) {
      return `https://news.ycombinator.com/item?id=${id}`;
    }
  } catch {
    return value;
  }
  return value;
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
       AND metadata->>'automation_output' = 'signals'
       AND metadata->>'automation_id' = '${Number(ctx.automation.id)}'
     ORDER BY id`
  )) as PersistedSignal[];
  const deliveredDrafts = (await client.query(
    `SELECT id, author_name, payload_text, source_url, metadata FROM events
     WHERE ${runPredicate}
       AND semantic_type = 'draft_reply'
       AND metadata->>'automation_output' = 'drafts'
       AND metadata->>'automation_id' = '${Number(ctx.automation.id)}'
     ORDER BY id`
  )) as PersistedDraft[];

  // Only draft-ready notifications are delivered. The "everything I noticed"
  // digest added a raw timeline dump (source tweets + signals) as a second
  // notification; the draft-ready cards already surface the curated, actionable
  // items, so a run with no drafts notifies nothing.
  if (deliveredDrafts.length === 0) {
    return;
  }

  const automationSource = {
    automation_id: ctx.automation.id,
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
      continue;
    }
    if (platform === "linkedin" && !isReviewableLinkedInPostUrl(sourceUrl)) {
      client.log(
        "Saved LinkedIn draft has only the generic feed URL; a durable post permalink is required before scheduling.",
        { draft_event_id: draft.id, source_url: sourceUrl }
      );
      continue;
    }

    // HN's story comment box lives on the item page, so the activation target
    // AND the notification's browser_url must be the same item URL — the user
    // clicks the notification and lands on the page where the comment box is.
    // Computed once so the two cannot drift apart.
    const targetUrl =
      platform === "hackernews" ? hnItemUrl(sourceUrl) : sourceUrl;
    // HN drafts must reference a real item page — a mislabeled URL would
    // otherwise become the page-activation target and fail later in the
    // connector. Skip like the LinkedIn durable-link guard.
    if (
      platform === "hackernews" &&
      !/^https:\/\/news\.ycombinator\.com\/item\?id=\d+$/.test(targetUrl)
    ) {
      client.log("Saved Hacker News draft has no durable item URL; skipping.", {
        draft_event_id: draft.id,
        source_url: sourceUrl,
      });
      continue;
    }

    let result: Awaited<ReturnType<ReactionClient["operations"]["execute"]>>;
    try {
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
        automation_source: automationSource,
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
      browser_url: targetUrl,
      idempotency_key: `social-radar:draft-ready:${draft.id}`,
      automation_source: automationSource,
    });
  }
};
