import { describe, expect, test } from "bun:test";
import { generateWorkerToken, verifyWorkerToken } from "@lobu/core";
import { assertRoutableInteraction } from "../interactions.js";

/**
 * Regression for the prod incident where every chat-platform `ask_user`
 * 500'd. #1271 made the worker use the per-run token as its PRIMARY gateway
 * auth (`session-runner`: `runJobToken || WORKER_TOKEN`), but `MessageConsumer`
 * minted that token WITHOUT `connectionId`. So the interaction route's
 * `assertRoutableInteraction` rejected the post (a chat-platform interaction
 * with no connectionId) and `postQuestion` threw before emitting.
 *
 * These tests pin the contract: the per-run worker token must carry
 * connectionId, and a token that carries it routes; one that doesn't is
 * exactly the failure we shipped.
 */
describe("runJobToken carries connectionId for interaction routing", () => {
  const CONN = "cfa916c95eb64939";

  test("a per-run token minted WITH connectionId routes interactions", () => {
    const token = generateWorkerToken("U_USER", "slack:DM:123.456", "dep-1", {
      channelId: "slack:DM",
      teamId: "T_TEAM",
      agentId: "crm",
      organizationId: "org_lobucrm",
      platform: "slack",
      connectionId: CONN,
      runId: 42,
    });
    const decoded = verifyWorkerToken(token);
    expect(decoded?.connectionId).toBe(CONN);
    // The route does exactly this with the decoded worker context; must not throw.
    expect(() =>
      assertRoutableInteraction(decoded?.connectionId, "slack", "question")
    ).not.toThrow();
  });

  test("the shipped bug: a per-run token WITHOUT connectionId is rejected", () => {
    const token = generateWorkerToken("U_USER", "slack:DM:123.456", "dep-1", {
      channelId: "slack:DM",
      teamId: "T_TEAM",
      agentId: "crm",
      organizationId: "org_lobucrm",
      platform: "slack",
      runId: 42,
      // connectionId intentionally omitted — reproduces the #1271 regression
    });
    const decoded = verifyWorkerToken(token);
    expect(decoded?.connectionId).toBeUndefined();
    expect(() =>
      assertRoutableInteraction(decoded?.connectionId, "slack", "question")
    ).toThrow();
  });

  test("api platform is exempt (no connectionId required)", () => {
    expect(() =>
      assertRoutableInteraction(undefined, "api", "question")
    ).not.toThrow();
  });
});
