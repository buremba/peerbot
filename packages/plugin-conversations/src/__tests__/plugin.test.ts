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
    // The gateway 400s suggest_actions on every non-api platform, so exposing it
    // there advertises a capability that cannot work. An undefined platform is
    // included deliberately: unknown must fail closed, not default to api.
    for (const platform of ["slack", "telegram", undefined]) {
      const tools = createConversationTools({ ...params, platform });
      expect(tools.map((tool) => tool.name)).toEqual(BASE_TOOLS);
    }
  });
});
