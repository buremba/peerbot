import { describe, expect, test } from "bun:test";
import { buildConversationUrl } from "../conversation-url";

describe("buildConversationUrl", () => {
  test("telegram supergroup -> public t.me/c link, prefix stripped", () => {
    expect(
      buildConversationUrl({
        platform: "telegram",
        channelId: "telegram:-1001234567890",
        messageId: "42",
      })
    ).toBe("https://t.me/c/1234567890/42");
  });

  test("telegram basic/private chat (no -100) -> no shareable URL", () => {
    expect(
      buildConversationUrl({
        platform: "telegram",
        channelId: "telegram:12345",
        messageId: "42",
      })
    ).toBeUndefined();
  });

  test("slack -> undefined until the workspace domain is plumbed (no 404 guess)", () => {
    expect(
      buildConversationUrl({
        platform: "slack",
        channelId: "slack:C0ABC123",
        messageId: "1699560000.001900",
      })
    ).toBeUndefined();
  });

  test("telegram with a non-numeric (synthetic) messageId -> undefined", () => {
    expect(
      buildConversationUrl({
        platform: "telegram",
        channelId: "telegram:-1001234567890",
        messageId: "click-abc123",
      })
    ).toBeUndefined();
  });

  test("channelId without a platform prefix still works", () => {
    expect(
      buildConversationUrl({
        platform: "telegram",
        channelId: "-1009999",
        messageId: "7",
      })
    ).toBe("https://t.me/c/9999/7");
  });

  test("platforms with no addressable URL -> undefined", () => {
    for (const platform of ["discord", "whatsapp", "teams", "gchat", "api"]) {
      expect(
        buildConversationUrl({
          platform,
          channelId: `${platform}:C1`,
          messageId: "1",
        })
      ).toBeUndefined();
    }
  });

  test("missing messageId -> undefined", () => {
    expect(
      buildConversationUrl({
        platform: "telegram",
        channelId: "telegram:-1001",
        messageId: "",
      })
    ).toBeUndefined();
  });
});
