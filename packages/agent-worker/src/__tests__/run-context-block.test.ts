import { describe, expect, test } from "bun:test";
import { buildRunContextBlock } from "../openclaw/worker";

describe("buildRunContextBlock", () => {
  test("renders platform, channel, sender, thread from platformMetadata", () => {
    const out = buildRunContextBlock({
      platform: "slack",
      channelId: "C0FALLBACK",
      platformMetadata: {
        responseChannel: "#support",
        responseThreadId: "1699.0001",
        senderDisplayName: "Burak",
      },
    });
    expect(out).toContain("## This conversation");
    expect(out).toContain("- Platform: slack");
    expect(out).toContain("- Channel: #support");
    expect(out).toContain("- Thread: 1699.0001");
    expect(out).toContain("- Triggered by: Burak");
  });

  test("falls back to channelId when metadata has no channel", () => {
    const out = buildRunContextBlock({
      platform: "slack",
      channelId: "C0FALLBACK",
      platformMetadata: {},
    });
    expect(out).toContain("- Channel: C0FALLBACK");
  });

  test("prefers senderDisplayName over senderUsername", () => {
    const out = buildRunContextBlock({
      platform: "slack",
      channelId: "C1",
      platformMetadata: { senderDisplayName: "Ada L.", senderUsername: "ada" },
    });
    expect(out).toContain("- Triggered by: Ada L.");
    expect(out).not.toContain("ada");
  });

  test("renders a link opportunistically when the gateway provides one", () => {
    const out = buildRunContextBlock({
      platform: "slack",
      channelId: "C1",
      platformMetadata: { conversationUrl: "https://slack/archives/C1/p1" },
    });
    expect(out).toContain("- Link: https://slack/archives/C1/p1");
  });

  test("omits unknown/empty fields rather than showing 'unknown'", () => {
    const out = buildRunContextBlock({
      platform: "slack",
      channelId: undefined,
      platformMetadata: { senderUsername: "  " },
    });
    expect(out).toBe("## This conversation\n- Platform: slack");
    expect(out).not.toContain("Channel");
    expect(out).not.toContain("Triggered by");
  });

  test("returns empty string when nothing is known", () => {
    expect(
      buildRunContextBlock({
        platform: undefined,
        channelId: undefined,
        platformMetadata: null,
      })
    ).toBe("");
    expect(
      buildRunContextBlock({
        platform: undefined,
        channelId: undefined,
        platformMetadata: "not-an-object",
      })
    ).toBe("");
  });
});
