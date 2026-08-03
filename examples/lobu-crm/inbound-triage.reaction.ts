/**
 * Notification-only reaction for the `inbound-triage` Behavior.
 *
 * Declared outputs persist every triage note. This reaction only delivers the
 * human-facing notification when the output array is non-empty.
 */
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

export const input = {
  type: "object",
  properties: {
    triage_notes: {
      type: "array",
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
  required: ["triage_notes"],
};

interface TriageDraft {
  title?: string;
  content: string;
}

export default async (
  ctx: ReactionContext,
  client: ReactionClient
): Promise<void> => {
  const notes =
    (ctx.extracted_data as { triage_notes?: TriageDraft[] }).triage_notes ?? [];
  if (notes.length === 0) return;

  await client.notifications.send({
    title: notes[0].title ?? `Inbound triage — ${notes.length} action(s)`,
    body: notes.map((note) => note.content).join("\n\n"),
    behavior_source: {
      behavior_id: ctx.window.behavior_id,
      window_id: ctx.window.id,
    },
  });
};
