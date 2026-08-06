import { describe, expect, test } from "bun:test";
import {
  resolveAgentId,
  resolveAgentOptions,
} from "../services/platform-helpers.js";

describe("resolveAgentOptions model resolution (layered fallback)", () => {
  test("behavior override (baseOptions.model) wins over the agent default", async () => {
    const settingsStore = {
      getSettings: async () => ({ models: ["openai/gpt-5"] }) as any,
    };

    const resolved = await resolveAgentOptions(
      "agent-1",
      { model: "claude/claude-opus-4-8" },
			settingsStore as any,
      "org-1",
    );

    // The per-behavior override is highest priority.
    expect(resolved.model).toBe("claude/claude-opus-4-8");
  });

  test("uses the agent models[0] when no behavior override", async () => {
    const settingsStore = {
      getSettings: async () => ({ models: ["openai/gpt-5"] }) as any,
    };

    const resolved = await resolveAgentOptions(
      "agent-1",
      {},
			settingsStore as any,
      "org-1",
    );

    expect(resolved.model).toBe("openai/gpt-5");
  });

  test("#6: a legacy 'auto' override is IGNORED and falls back to the agent default", async () => {
    // A stale Listen binding with model='auto' must NOT propagate as the run
    // model — `auto` is gone repo-wide. The malformed override is dropped and
    // the agent's models[0] wins.
    const settingsStore = {
      getSettings: async () => ({ models: ["openai/gpt-5"] }) as any,
    };

    const resolved = await resolveAgentOptions(
      "agent-1",
      { model: "auto" },
			settingsStore as any,
      "org-1",
    );

    expect(resolved.model).toBe("openai/gpt-5");
    expect(resolved.model).not.toBe("auto");
  });

  test("#6: a bare (unqualified) override is IGNORED and falls back to the agent default", async () => {
    const settingsStore = {
      getSettings: async () => ({ models: ["openai/gpt-5"] }) as any,
    };

    const resolved = await resolveAgentOptions(
      "agent-1",
      { model: "gpt-4o" }, // no provider prefix
			settingsStore as any,
      "org-1",
    );

    expect(resolved.model).toBe("openai/gpt-5");
  });

  test("a valid <provider>/<model> override still wins over the agent default", async () => {
    const settingsStore = {
      getSettings: async () => ({ models: ["openai/gpt-5"] }) as any,
    };

    const resolved = await resolveAgentOptions(
      "agent-1",
      { model: "claude/claude-sonnet-5" },
			settingsStore as any,
      "org-1",
    );

    // Note: the exact-allow-list gate (deployment-manager backstop) validates
    // this later; resolveAgentOptions only ensures a WELL-FORMED override wins.
    expect(resolved.model).toBe("claude/claude-sonnet-5");
  });

  test("reads the agent row scoped to the caller's org (shared agent id across orgs)", async () => {
    // A shared agent id (e.g. "lobu-builder") exists in multiple orgs, each with
    // its own models list. The worker-dispatch path has no ambient orgContext,
    // so getSettings MUST receive the org explicitly — otherwise it reads an
    // arbitrary org's row and mis-resolves the model (the Gemini/Claude 404 bug).
    const rowsByOrg: Record<string, { models: string[] }> = {
      "org-a": { models: ["claude/claude-sonnet-4-6"] },
      "org-b": { models: ["gemini/gemini-2.5-flash"] },
    };
    const seenAgentIds: string[] = [];
    const settingsStore = {
      getSettings: async (
        agentId: string,
        context?: { organizationId?: string },
      ) => {
        seenAgentIds.push(agentId);
        // Mirror the store contract: an unscoped read is ambiguous. Simulate the
        // real bug by returning the WRONG org's row when no org is passed.
        const org = context?.organizationId ?? "org-a";
        return rowsByOrg[org] as any;
      },
    };

    const resolved = await resolveAgentOptions(
      "lobu-builder",
      {},
      settingsStore as any,
      "org-b",
    );

    // The store was queried for the right agent, and org-b's model resolved —
    // not the default/first org's Claude model.
    expect(seenAgentIds).toEqual(["lobu-builder"]);
    expect(resolved.model).toBe("gemini/gemini-2.5-flash");
  });

  test("clears model when neither behavior nor agent nor org sets one (worker throws)", async () => {
    const settingsStore = {
      getSettings: async () => ({}) as any,
    };

    // organizationId undefined ⇒ no org lookup ⇒ nothing resolved.
    const resolved = await resolveAgentOptions(
      "agent-1",
      { model: "" },
			settingsStore as any,
      undefined,
    );

    expect(resolved.model).toBeUndefined();
  });
});

describe("resolveAgentId", () => {
  test("returns null when no binding and connection has no agent", async () => {
    const resolved = await resolveAgentId({
      platform: "telegram",
      channelId: "12345",
    });

    expect(resolved).toBeNull();
  });

  test("existing binding wins over connection agent", async () => {
    const bindingService = {
			resolveForConnection: async (
				connectionId: string,
        channelId: string,
				organizationId: string,
      ) => {
				expect(connectionId).toBe("conn-1");
        expect(channelId).toBe("C1");
				expect(organizationId).toBe("org-1");
				return { agentId: "bound-agent", platform: "slack", channelId };
      },
    };

    const resolved = await resolveAgentId({
      platform: "slack",
      channelId: "C1",
      teamId: "T1",
      agentId: "connection-agent",
			connectionId: "conn-1",
			organizationId: "org-1",
      behaviorSubscriptionService: bindingService as any,
    });

    expect(resolved).toEqual({
      agentId: "bound-agent",
      source: "subscription",
    });
  });

  test("per-binding model override propagates from the binding (Listen behavior)", async () => {
    const bindingService = {
      resolveForConnection: async (
        _connectionId: string,
        channelId: string,
      ) => ({
        agentId: "bound-agent",
        platform: "slack",
        channelId,
        organizationId: "org-1",
        model: "openai/gpt-5",
      }),
    };

    const resolved = await resolveAgentId({
      platform: "slack",
      channelId: "C1",
      agentId: "connection-agent",
      connectionId: "conn-1",
      organizationId: "org-1",
      behaviorSubscriptionService: bindingService as any,
    });

    expect(resolved).toEqual({
      agentId: "bound-agent",
      source: "subscription",
      organizationId: "org-1",
      model: "openai/gpt-5",
    });
  });

  test("no binding + agentId routes to connection agent", async () => {
    const bindingService = {
			resolveForConnection: async () => null,
    };

    const resolved = await resolveAgentId({
      platform: "slack",
      channelId: "C1",
      teamId: "T1",
      agentId: "connection-agent",
      behaviorSubscriptionService: bindingService as any,
    });

    expect(resolved).toEqual({
      agentId: "connection-agent",
      source: "connection",
    });
  });

  test("no binding + no connection agent returns null", async () => {
    const bindingService = {
			resolveForConnection: async () => null,
    };

    const resolved = await resolveAgentId({
      platform: "slack",
      channelId: "C1",
      teamId: "T1",
      behaviorSubscriptionService: bindingService as any,
    });

    expect(resolved).toBeNull();
  });

  test("connection agent works on platforms without teamId (Telegram)", async () => {
    const bindingService = {
			resolveForConnection: async () => null,
    };

    const resolved = await resolveAgentId({
      platform: "telegram",
      channelId: "12345",
      agentId: "my-tg-agent",
      behaviorSubscriptionService: bindingService as any,
    });

    expect(resolved).toEqual({
      agentId: "my-tg-agent",
      source: "connection",
    });
  });

  test("resolver does NOT write bindings — pure side-effect-free", async () => {
    let createCount = 0;
    const bindingService = {
			resolveForConnection: async () => null,
      createChatBehavior: async () => {
        createCount += 1;
      },
    };

    await resolveAgentId({
      platform: "slack",
      channelId: "C1",
      teamId: "T1",
      agentId: "connection-agent",
      behaviorSubscriptionService: bindingService as any,
    });

    // Bridge owns the auto-bind side effect, not the resolver.
    expect(createCount).toBe(0);
  });
});

/**
 * Routing must honour an explicit `<provider>/<model>` ref whatever LAYER supplied it.
 *
 * The worker only reroutes away from the gateway's `defaultProvider` when
 * `allowInstalledProviderOverride` is set, and that flag is
 * `rawOptions.behaviorModelOverride === true` (agent-worker
 * `runtime/session-runner.ts`). Dispatch sites set `behaviorModelOverride` only
 * alongside an explicit per-run override (e.g. the request body in
 * `gateway/routes/public/agent.ts`) — but the layered fallback runs AFTER that,
 * and resolves an equally explicit ref out of `agent.models[0]` or the org
 * default. Nothing re-derived the flag, so an agent-level provider choice was
 * silently dropped for routing.
 *
 * Measured on prod 2026-08-06: org `buremba` had agent `personal-agent` pinned to
 * `gemini/gemini-2.5-pro`, no Behavior override, and NO z-ai provider, secret, or
 * system key of its own — yet 79 runs over three days failed with
 * `z.ai returned an error: 429 Insufficient balance`. Setting a per-Behavior
 * `execution_config.model` (which flips the flag) fixed it immediately: 4/4 runs
 * completed against prior success rates of 19% and 41%. That is the natural
 * experiment this test pins.
 */
describe("explicit model refs mark the routing override", () => {
  const storeWith = (models: string[]) =>
    ({ getSettings: async () => ({ models }) as any }) as any;

  test("an agent-level <provider>/<model> ref marks the override", async () => {
    const resolved = await resolveAgentOptions(
      "agent-1",
      {},
      storeWith(["gemini/gemini-2.5-pro"]),
      "org-1",
    );

    expect(resolved.model).toBe("gemini/gemini-2.5-pro");
    // Without this the worker ignores the `gemini/` prefix and routes to
    // whatever module the gateway published as `defaultProvider`.
    expect(resolved.behaviorModelOverride).toBe(true);
  });

  test("a per-behavior override still marks the override", async () => {
    const resolved = await resolveAgentOptions(
      "agent-1",
      { model: "qwen/qwen3.8-max-preview", behaviorModelOverride: true },
      storeWith(["gemini/gemini-2.5-pro"]),
      "org-1",
    );

    expect(resolved.model).toBe("qwen/qwen3.8-max-preview");
    expect(resolved.behaviorModelOverride).toBe(true);
  });

  // The flag authorizes rerouting to an explicitly NAMED provider. A ref with no
  // provider segment names none, so it must not authorize anything — the worker
  // would have nothing to route to and would fall through to defaultProvider
  // anyway, but claiming an override we cannot honour is a lie in the payload.
  test("an unqualified agent model does NOT mark the override", async () => {
    const resolved = await resolveAgentOptions(
      "agent-1",
      {},
      storeWith(["gpt-4o"]),
      "org-1",
    );

    expect(resolved.model).toBe("gpt-4o");
    expect(resolved.behaviorModelOverride).toBeUndefined();
  });

  // A malformed per-request override is dropped in favour of the agent default
  // (existing behaviour). The flag must follow the ref that actually WON, not the
  // one that was rejected.
  test("a rejected 'auto' override falls back and marks the agent ref", async () => {
    const resolved = await resolveAgentOptions(
      "agent-1",
      { model: "auto", behaviorModelOverride: true },
      storeWith(["gemini/gemini-2.5-pro"]),
      "org-1",
    );

    expect(resolved.model).toBe("gemini/gemini-2.5-pro");
    expect(resolved.behaviorModelOverride).toBe(true);
  });

  // The clearing branch: a rejected override arrives with the flag already true,
  // and the winning fallback ref names no provider. Merely spreading baseOptions
  // would leave the stale `true` authorizing a ref that cannot be routed — the
  // flag must be cleared along with the rejected override.
  test("a rejected override does NOT leave a stale flag on an unqualified fallback", async () => {
    const resolved = await resolveAgentOptions(
      "agent-1",
      { model: "auto", behaviorModelOverride: true },
      storeWith(["gpt-4o"]),
      "org-1",
    );

    expect(resolved.model).toBe("gpt-4o");
    expect(resolved.behaviorModelOverride).toBeUndefined();
  });
});
