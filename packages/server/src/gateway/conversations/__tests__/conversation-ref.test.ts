import { describe, expect, test } from "bun:test";
import {
  conversationRefsMatch,
  parseConversationRef,
} from "../conversation-ref.js";

describe("parseConversationRef", () => {
  test("channel-level conversation has no thread", () => {
    expect(parseConversationRef("slack:D095U1QV667")).toEqual({
      channelKey: "slack:D095U1QV667",
    });
  });

  test("a trailing empty segment still denotes the channel, not a thread", () => {
    // Slack top-level DMs arrive as `slack:D…:` with an empty thread_ts. A
    // naive `===` against the channel form reports a false mismatch here,
    // which would let the double-post through for every DM.
    expect(parseConversationRef("slack:D095U1QV667:")).toEqual({
      channelKey: "slack:D095U1QV667",
    });
  });

  test("thread conversation keeps its root", () => {
    expect(parseConversationRef("slack:C123:1700000000.123456")).toEqual({
      channelKey: "slack:C123",
      threadId: "1700000000.123456",
    });
  });

  test("telegram forum topic parses as a thread", () => {
    expect(parseConversationRef("telegram:-1001234:55")).toEqual({
      channelKey: "telegram:-1001234",
      threadId: "55",
    });
  });

  test("malformed or empty ids yield null", () => {
    expect(parseConversationRef(undefined)).toBeNull();
    expect(parseConversationRef("")).toBeNull();
    expect(parseConversationRef("slack")).toBeNull();
    expect(parseConversationRef("slack:")).toBeNull();
  });
});

describe("conversationRefsMatch", () => {
  test("same channel, both channel-level", () => {
    expect(
      conversationRefsMatch(
        { channelKey: "slack:D1" },
        parseConversationRef("slack:D1:")
      )
    ).toBe(true);
  });

  test("same channel and same thread", () => {
    expect(
      conversationRefsMatch(
        { channelKey: "slack:C1", threadId: "1700.1" },
        parseConversationRef("slack:C1:1700.1")
      )
    ).toBe(true);
  });

  test("same channel but different thread is NOT a match", () => {
    // Answering in a sibling thread is not answering the run's conversation.
    expect(
      conversationRefsMatch(
        { channelKey: "slack:C1", threadId: "1700.2" },
        parseConversationRef("slack:C1:1700.1")
      )
    ).toBe(false);
  });

  test("channel-level post does not match a thread in that channel", () => {
    expect(
      conversationRefsMatch(
        { channelKey: "slack:C1" },
        parseConversationRef("slack:C1:1700.1")
      )
    ).toBe(false);
  });

  test("different channels never match", () => {
    expect(
      conversationRefsMatch(
        { channelKey: "slack:C2" },
        parseConversationRef("slack:C1")
      )
    ).toBe(false);
  });

  test("a null side never matches — an unparseable id must not suppress", () => {
    expect(conversationRefsMatch({ channelKey: "slack:C1" }, null)).toBe(false);
    expect(conversationRefsMatch(null, { channelKey: "slack:C1" })).toBe(false);
  });
});
