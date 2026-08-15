/**
 * Notification-only reaction for the `funnel-digest` Automation.
 *
 * The Automation's declared `digests` output persists the summary event before
 * this runs. The reaction has one job that is intentionally imperative: fan
 * the already-authored digest out to the team's notification connections.
 */
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

export const input = {
  type: "object",
  properties: {
    digests: {
      type: "array",
      maxItems: 1,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          content: { type: "string", minLength: 1 },
          metadata: { type: "object" },
        },
        required: ["content"],
      },
    },
  },
  required: ["digests"],
};

interface DigestDraft {
  title?: string;
  content: string;
}

export default async (
  ctx: ReactionContext,
  client: ReactionClient
): Promise<void> => {
  const drafts =
    (ctx.extracted_data as { digests?: DigestDraft[] }).digests ?? [];
  const digest = drafts[0];
  if (!digest) return;

  await client.notifications.send({
    title:
      digest.title ??
      `Weekly funnel digest — ${ctx.window.window_end.slice(0, 10)}`,
    body: digest.content,
    automation_source: {
      automation_id: ctx.window.automation_id,
      window_id: ctx.window.id,
    },
  });
};
