import { type Static, Type } from "@sinclair/typebox";

// ============================================
// Typebox Schema (Flattened for MCP)
// ============================================

export const ManageConversationsSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list", {
        description: "List an agent's conversations, newest-first.",
      }),
      Type.Literal("get", {
        description:
          "Fetch one conversation by its (platform, conversation_id).",
      }),
      Type.Literal("send", {
        description:
          "Send a message to an agent conversation and (by default) return its reply. " +
          "Runs the turn against the conversation's pinned sandbox realm.",
      }),
    ],
    { description: "Action to perform" }
  ),

  agent_id: Type.String({
    description:
      'Target agent id (lowercase slug, e.g. "researcher"). Required for every action.',
  }),

  platform: Type.Optional(
    Type.String({
      description:
        '[get] Conversation platform ("web" for app-owned conversations, or a channel platform like "slack"). Defaults to "web".',
    })
  ),
  conversation_id: Type.Optional(
    Type.String({
      description:
        "[get] The stored conversation id. For [send], omit to target the caller's default web thread, " +
        "or pass a `thread` to open/resume a named web thread.",
    })
  ),

  thread: Type.Optional(
    Type.String({
      description:
        "[send] Optional web thread name. Distinct threads keep separate history + separate pinned sandbox. Omit for the default thread.",
    })
  ),
  text: Type.Optional(
    Type.String({
      description: "[send] Message text to deliver to the agent.",
    })
  ),
  model: Type.Optional(
    Type.String({
      description:
        "[send] Optional per-message model override as a `provider/model` ref. Wins over the agent/org default.",
    })
  ),
  wait: Type.Optional(
    Type.Boolean({
      description:
        "[send] When true (default), block until the agent's turn completes and return its reply. " +
        "When false, enqueue and return immediately with the message id.",
    })
  ),
  timeout_ms: Type.Optional(
    Type.Number({
      description:
        "[send, wait=true] Max time to wait for the reply. Default 60000, capped at 170000. " +
        'On timeout the turn keeps running and status is "timeout" (the answer is not lost); ' +
        "raise timeout_ms for a longer wait. The reply is not retrievable through `get`.",
      minimum: 1000,
      maximum: 170_000,
    })
  ),
});

// ============================================
// Type Definitions
// ============================================

export type ManageConversationsArgs = Static<typeof ManageConversationsSchema>;

/** One conversation as surfaced by list/get. */
export interface ConversationRecord {
  platform: string;
  conversation_id: string;
  /** "owned" (an app/web thread) or "platform" (an external channel). */
  kind: "owned" | "platform";
  user_id: string | null;
  title: string | null;
  last_activity_at: string;
  created_at: string;
}

export type ManageConversationsResult =
  | { action: "list"; conversations: ConversationRecord[] }
  | { action: "get"; conversation: ConversationRecord }
  | {
      // wait=false, or wait=true that timed out before completion.
      action: "send";
      conversation_id: string;
      message_id: string;
      status: "queued" | "timeout";
    }
  | {
      // wait=true and the turn reached a terminal state.
      action: "send";
      conversation_id: string;
      message_id: string;
      status: "complete" | "error";
      /** The agent's final reply text (status="complete"). */
      reply?: string;
      /** The terminal error message (status="error"). */
      error?: string;
    };
