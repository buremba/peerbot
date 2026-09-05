/**
 * ClientSDK `conversations` namespace. Thin wrapper over `manageConversations`.
 *
 * A conversation is the durable unit an agent talks over — history + its frozen
 * sandbox realm both live here (see the `conversations` entity). `send` drives a
 * turn against one; the reply reads back on the same conversation id.
 */

import type {
  ConversationGetInput,
  ConversationListInput,
  ConversationSendInput,
} from "@lobu/core/contracts/tools/manage-conversations";
import { Type } from "@sinclair/typebox";
import type { Env } from "../../index";
import { setCurrentMcpConversationTitle } from "../../lobu/stores/mcp-client-conversations";
import { manageConversations } from "../../tools/admin/manage_conversations";
import type { ToolContext } from "../../tools/registry";
import { withValidatedArgs } from "../../tools/validate-args";
import { createValidatedSdkMethod } from "../sdk-preflight";
import { createActionCaller } from "./action-call";

const SetTitleSchema = Type.Object({ title: Type.String() });

export interface ConversationsNamespace {
  /** Set display-only text for the current MCP host conversation. */
  setTitle(input: { title: string }): Promise<{ title: string }>;
  manage(input: Record<string, unknown>): Promise<unknown>;
  list(input: ConversationListInput): Promise<unknown>;
  get(input: ConversationGetInput): Promise<unknown>;
  send(input: ConversationSendInput): Promise<unknown>;
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
