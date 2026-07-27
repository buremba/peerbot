import { describe, expect, test } from "bun:test";
import { createConversationTools } from "../index";

const BASE_TOOLS = [
  "list_conversations",
  "read_conversation",
  "send_message",
  "react",
  "edit_message",
  "delete_message",
  "ask_user",
];

const params = {
  gatewayUrl: "http://gateway",
  workerToken: "token",
  channelId: "channel",
  conversationId: "conversation",
  onAskUserPosted: () => undefined,
};

describe("conversation plugin", () => {
  test("owns the complete conversation and interaction tool set", () => {
    const tools = createConversationTools({ ...params, platform: "api" });
    expect(tools.map((tool) => tool.name)).toEqual([
      ...BASE_TOOLS,
      "suggest_actions",
    ]);
  });

  test("withholds suggest_actions off the api platform", () => {
    // The gateway rejects suggest_actions for every non-api conversation
    // (chat adapters have no delivery path yet), so composing it there hands
    // the agent a tool whose every call is a guaranteed 400.
    for (const platform of ["slack", "telegram", undefined]) {
      const tools = createConversationTools({ ...params, platform });
      expect(tools.map((tool) => tool.name)).toEqual(BASE_TOOLS);
    }
  });
});
