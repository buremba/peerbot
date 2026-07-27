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

  test("offers suggest_actions on every platform", () => {
    // Suggestions ride the interaction-card rail (Card/Actions/Button), the
    // same one ask_user already uses. Chip buttons carry only a short
    // `suggestion:<id>:<i>` action id (routing + prompt text live in a pending
    // row), which keeps the serialized callback inside Telegram's 64-byte
    // callback_data cap; platforms without card support degrade to a
    // numbered-list text via postWithFallback. This previously asserted the
    // OPPOSITE: the tool was gated to `api` because only the SPA had a
    // renderer.
    for (const platform of ["slack", "telegram", undefined]) {
      const tools = createConversationTools({ ...params, platform });
      expect(tools.map((tool) => tool.name)).toEqual([
        ...BASE_TOOLS,
        "suggest_actions",
      ]);
    }
  });
});
