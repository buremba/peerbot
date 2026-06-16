import { describe, expect, test } from "bun:test";
import {
  assertRoutableInteraction,
  assertSafeLinkButtonUrl,
} from "../interactions.js";

// These two guards are the post-time fail-closed checks that protect against
// (a) cross-platform/cross-tenant event leakage when a chat-platform
// interaction is posted without a routing key (#847), and (b) posting a link
// button whose scheme could execute code in the user's client. They are pure
// functions, so we exercise them directly.

describe("assertRoutableInteraction", () => {
  test("rejects a chat-platform interaction with no connectionId", () => {
    expect(() =>
      assertRoutableInteraction(undefined, "telegram", "question")
    ).toThrow(/connectionId is required to prevent cross-platform event leakage/);
  });

  test("rejects an empty-string connectionId on a chat platform", () => {
    expect(() =>
      assertRoutableInteraction("", "slack", "link button")
    ).toThrow(/connectionId is required/);
  });

  test("includes the interaction kind in the error message", () => {
    expect(() =>
      assertRoutableInteraction(undefined, "telegram", "tool approval")
    ).toThrow(/Refusing to post tool approval/);
  });

  test("accepts a chat-platform interaction with a non-empty connectionId", () => {
    expect(() =>
      assertRoutableInteraction("marketing-telegram", "telegram", "question")
    ).not.toThrow();
  });

  test("exempts platform=api even without a connectionId", () => {
    // API sessions have no Chat SDK connection; their cards route by
    // conversationId through the api platform's own subscriptions. Requiring a
    // connectionId here is what silently broke ask_user/tool-approval for every
    // API/SPA session (#847).
    expect(() =>
      assertRoutableInteraction(undefined, "api", "question")
    ).not.toThrow();
  });

  test("api exemption also holds for status messages (no connectionId)", () => {
    expect(() =>
      assertRoutableInteraction(undefined, "api", "status message")
    ).not.toThrow();
  });
});

describe("assertSafeLinkButtonUrl", () => {
  test("accepts https URLs", () => {
    expect(() =>
      assertSafeLinkButtonUrl("https://example.com/oauth/start")
    ).not.toThrow();
  });

  test("accepts http URLs", () => {
    expect(() =>
      assertSafeLinkButtonUrl("http://localhost:8787/connect")
    ).not.toThrow();
  });

  test("rejects javascript: scheme", () => {
    expect(() =>
      assertSafeLinkButtonUrl("javascript:alert(document.cookie)")
    ).toThrow(/unsafe scheme: javascript:/);
  });

  test("rejects data: scheme", () => {
    expect(() =>
      assertSafeLinkButtonUrl("data:text/html,<script>alert(1)</script>")
    ).toThrow(/unsafe scheme: data:/);
  });

  test("rejects file: scheme", () => {
    expect(() => assertSafeLinkButtonUrl("file:///etc/passwd")).toThrow(
      /unsafe scheme: file:/
    );
  });

  test("rejects vbscript: scheme", () => {
    expect(() =>
      assertSafeLinkButtonUrl("vbscript:msgbox(1)")
    ).toThrow(/unsafe scheme: vbscript:/);
  });

  test("rejects an unparseable URL", () => {
    expect(() => assertSafeLinkButtonUrl("not a url")).toThrow(
      /Invalid link button URL/
    );
  });
});
