import { describe, expect, test } from "bun:test";
import { createConversationTools } from "../index";

describe("conversation plugin", () => {
  test("owns the complete conversation and interaction tool set", () => {
    const tools = createConversationTools({
      gatewayUrl: "http://gateway",
      workerToken: "token",
      channelId: "channel",
      conversationId: "conversation",
      onAskUserPosted: () => undefined,
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_conversations",
      "read_conversation",
      "send_message",
      "react",
      "edit_message",
      "delete_message",
      "ask_user",
      "suggest_actions",
    ]);
  });
});
