import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { createInteractionRoutes } from "../../routes/internal/interactions.js";

// Persistence is exercised end-to-end against real Postgres in the integration
// suite (suggestion-persist.test.ts). Here we mock it to unit-test the route's
// GATING/VALIDATION: API-only platform check, server-side sanitize, and the
// missing-organization guard — none of which should touch the DB.
const persistSuggestion = mock(() => Promise.resolve(42));
mock.module("../../suggestions/persist-suggestion.js", () => ({
  persistSuggestion,
}));

describe("interaction routes", () => {
  let originalKey: string | undefined;
  let workerToken: string;
  let mockInteractionService: any;
  let router: ReturnType<typeof createInteractionRoutes>;

  beforeEach(() => {
    persistSuggestion.mockClear();
    originalKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    workerToken = generateWorkerToken("user-1", "conv-1", "deploy-1", {
      channelId: "chan-1",
      teamId: "team-1",
    });

    mockInteractionService = {
      postQuestion: mock(() => Promise.resolve({ id: "interaction-123" })),
      postLinkButton: mock(() => Promise.resolve({ id: "link-123" })),
    };

    router = createInteractionRoutes(mockInteractionService);
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ENCRYPTION_KEY = originalKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  describe("POST /internal/interactions/create", () => {
    test("returns 401 without auth header", async () => {
      const res = await router.request("/internal/interactions/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "test?", options: [] }),
      });
      expect(res.status).toBe(401);
    });

    test("returns 401 with invalid token", async () => {
      const res = await router.request("/internal/interactions/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer invalid-token",
        },
        body: JSON.stringify({ question: "test?", options: [] }),
      });
      expect(res.status).toBe(401);
    });

    test("posts question and returns id", async () => {
      const res = await router.request("/internal/interactions/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${workerToken}`,
        },
        body: JSON.stringify({
          question: "Which option?",
          options: ["A", "B"],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("interaction-123");
      expect(body.status).toBe("posted");
      expect(mockInteractionService.postQuestion).toHaveBeenCalledTimes(1);
    });

    test("posts link button and returns id", async () => {
      const res = await router.request("/internal/interactions/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${workerToken}`,
        },
        body: JSON.stringify({
          interactionType: "link_button",
          url: "https://example.com/device",
          label: "Connect GitHub",
          linkType: "oauth",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("link-123");
      expect(body.status).toBe("posted");
      expect(mockInteractionService.postLinkButton).toHaveBeenCalledTimes(1);
    });

    test("returns 500 on service error", async () => {
      mockInteractionService.postQuestion = mock(() =>
        Promise.reject(new Error("service down"))
      );
      const res = await router.request("/internal/interactions/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${workerToken}`,
        },
        body: JSON.stringify({ question: "test?", options: [] }),
      });
      expect(res.status).toBe(500);
    });
  });

  describe("POST /internal/suggestions/create", () => {
    // A fully-routable API turn: platform=api + an organization to scope the
    // durable row. This is the only shape that reaches persistSuggestion.
    const apiToken = () =>
      generateWorkerToken("user-1", "conv-1", "deploy-1", {
        channelId: "chan-1",
        teamId: "team-1",
        platform: "api",
        agentId: "lobu-builder",
        organizationId: "org-1",
        messageId: "msg-1",
      });

    test("persists suggestions from valid {title,message} prompts (API)", async () => {
      const res = await router.request("/internal/suggestions/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken()}`,
        },
        body: JSON.stringify({
          prompts: [
            { title: "Try this", message: "Do the first thing" },
            { title: "Or this", message: "Do the second thing" },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.prompts).toBe(2);
      expect(persistSuggestion).toHaveBeenCalledTimes(1);
      const args = persistSuggestion.mock.calls.at(-1)?.[0] as any;
      expect(args.organizationId).toBe("org-1");
      expect(args.turnMessageId).toBe("msg-1");
      expect(args.prompts).toHaveLength(2);
    });

    test("server-side rejects malformed prompts (bare strings) without persisting", async () => {
      const res = await router.request("/internal/suggestions/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken()}`,
        },
        // The worker is untrusted; bare strings are not valid {title,message}.
        body: JSON.stringify({ prompts: ["Try this", "Or this"] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.prompts).toBe(0);
      expect(persistSuggestion).not.toHaveBeenCalled();
    });

    test("rejects non-API platforms (no chat delivery yet) without persisting", async () => {
      const slackToken = generateWorkerToken("user-1", "conv-1", "deploy-1", {
        channelId: "chan-1",
        teamId: "team-1",
        platform: "slack",
        organizationId: "org-1",
        connectionId: "conn-9",
      });
      const res = await router.request("/internal/suggestions/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${slackToken}`,
        },
        body: JSON.stringify({ prompts: [{ title: "T", message: "M" }] }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(persistSuggestion).not.toHaveBeenCalled();
    });

    test("rejects an API turn with no organization context without persisting", async () => {
      const orglessToken = generateWorkerToken("user-1", "conv-1", "deploy-1", {
        channelId: "chan-1",
        teamId: "team-1",
        platform: "api",
      });
      const res = await router.request("/internal/suggestions/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${orglessToken}`,
        },
        body: JSON.stringify({ prompts: [{ title: "T", message: "M" }] }),
      });
      expect(res.status).toBe(400);
      expect(persistSuggestion).not.toHaveBeenCalled();
    });

    test("returns 401 without auth", async () => {
      const res = await router.request("/internal/suggestions/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompts: ["test"] }),
      });
      expect(res.status).toBe(401);
    });
  });
});
