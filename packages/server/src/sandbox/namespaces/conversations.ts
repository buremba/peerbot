/**
 * ClientSDK `conversations` namespace. Thin wrapper over `manageConversations`.
 *
 * A conversation is the durable unit an agent talks over — history + its frozen
 * sandbox realm both live here (see the `conversations` entity). `send` drives a
 * turn against one; the reply reads back on the same conversation id.
 */

import { Type } from "@sinclair/typebox";
import type { Env } from "../../index";
import { setCurrentMcpConversationTitle } from "../../lobu/stores/mcp-client-conversations";
import { manageConversations } from "../../tools/admin/manage_conversations";
import type { ToolContext } from "../../tools/registry";
import { withValidatedArgs } from "../../tools/validate-args";
import { createValidatedSdkMethod } from "../sdk-preflight";
import { createActionCaller } from "./action-call";

const SetTitleSchema = Type.Object({ title: Type.String() });

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
  /** Set display-only text for the current MCP host conversation. */
  setTitle(input: { title: string }): Promise<{ title: string }>;
  manage(input: Record<string, unknown>): Promise<unknown>;
  list(input: ConversationsListInput): Promise<unknown>;
  get(input: ConversationsGetInput): Promise<unknown>;
  send(input: ConversationsSendInput): Promise<unknown>;
}

export function buildConversationsNamespace(
  ctx: ToolContext,
  env: Env,
): ConversationsNamespace {
  const { manage, method } = createActionCaller(
    manageConversations,
    env,
    ctx,
    "conversations",
  );
  const setTitle = withValidatedArgs(
    "client.conversations.setTitle",
    SetTitleSchema,
    async (input: { title: string }) =>
      setCurrentMcpConversationTitle(ctx, input.title),
  );

  return {
    setTitle: createValidatedSdkMethod(setTitle, [], {
      path: "conversations.setTitle",
      prepareArgs: (input) => input,
    }),
    manage,
    list: method("list"),
    get: method("get"),
    // `send` returns a discriminated result whose `status` is part of the
    // contract — "error" and "timeout" are NON-throwing outcomes the caller
    // must branch on. Disable the named-method failure conversion for this one
    // method; genuine handler faults still throw.
    send: method("send", { checkFailure: false }),
  };
}
