/**
 * ClientSDK `conversations` namespace. Thin wrapper over `manageConversations`.
 *
 * A conversation is the durable unit an agent talks over — history + its frozen
 * sandbox realm both live here (see the `conversations` entity). `send` drives a
 * turn against one; the reply reads back on the same conversation id.
 */

import type { Env } from "../../index";
import { manageConversations } from "../../tools/admin/manage_conversations";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export interface ConversationsListInput {
  agent_id: string;
}

export interface ConversationsGetInput {
  agent_id: string;
  /** Defaults to "web" (the app-owned realm). */
  platform?: string;
  conversation_id: string;
}

export interface ConversationsSendInput {
  agent_id: string;
  /** Resume an exact conversation; wins over `thread`. */
  conversation_id?: string;
  /** Open/resume a named web thread (own history + own pinned sandbox). */
  thread?: string;
  text: string;
  /** Per-message `provider/model` override. */
  model?: string;
  /** Await the reply (default true); false returns immediately with the id. */
  wait?: boolean;
  /** [wait=true] Max wait (ms). Default 45000, capped at 170000. */
  timeout_ms?: number;
}

export interface ConversationsNamespace {
  manage(input: Record<string, unknown>): Promise<unknown>;
  list(input: ConversationsListInput): Promise<unknown>;
  get(input: ConversationsGetInput): Promise<unknown>;
  send(input: ConversationsSendInput): Promise<unknown>;
}

export function buildConversationsNamespace(
  ctx: ToolContext,
  env: Env,
): ConversationsNamespace {
  const { manage, action } = createActionCaller(
    manageConversations,
    env,
    ctx,
    "conversations",
  );

  return {
    manage,
    list: (input) => action("list", input),
    get: (input) => action("get", input),
    // `send` returns a discriminated result whose `status` is part of the
    // contract — "error" and "timeout" are NON-throwing outcomes the caller
    // must branch on. Route it through `manage` (the raw handler) rather than
    // `action`, whose failureMessage() turns status:"error"/"timeout" into a
    // thrown ClientSdkActionError. A genuine fault (bad input, agent-not-found)
    // still throws — the handler raises ToolUserError for those.
    send: (input) => manage({ ...input, action: "send" }),
  };
}
