import { describe, expect, mock, test } from "bun:test";
import { resolveChatTarget } from "../platforms/shared.js";

describe("resolveChatTarget", () => {
  test("routes a canonical platform-prefixed DM channel without double-prefixing it", async () => {
    const target = { post: mock(async () => undefined) };
    const channel = mock((key: string) =>
      key === "slack:D095" ? target : null
    );

    const resolved = await resolveChatTarget(
      { channel },
      "slack",
      {
        channelId: "slack:D095",
        conversationId: "slack:D095",
      }
    );

    expect(resolved).toBe(target);
    expect(channel).toHaveBeenCalledWith("slack:D095");
  });

  test("prefixes a raw channel id from a direct platform caller", async () => {
    const target = { post: mock(async () => undefined) };
    const channel = mock((key: string) =>
      key === "slack:D095" ? target : null
    );

    const resolved = await resolveChatTarget(
      { channel },
      "slack",
      {
        channelId: "D095",
        conversationId: "D095",
      }
    );

    expect(resolved).toBe(target);
    expect(channel).toHaveBeenCalledWith("slack:D095");
  });
});
