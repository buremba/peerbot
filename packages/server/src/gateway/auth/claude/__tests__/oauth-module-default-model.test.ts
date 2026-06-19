import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ClaudeOAuthModule } from "../oauth-module.js";

/**
 * getDefaultModel() powers auto-mode model resolution: the gateway asks the
 * Claude module for the agent's default (newest live) model. It must use the
 * system env key (ANTHROPIC_API_KEY) when the agent has no auth profile —
 * otherwise an env-configured Anthropic agent resolves to no model and the
 * worker throws "No model configured".
 */
describe("ClaudeOAuthModule.getDefaultModel — env-key credential", () => {
  const ENV_KEYS = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    globalThis.fetch = originalFetch;
  });

  function makeModule(): ClaudeOAuthModule {
    // No per-agent profile — forces the system-env-key path.
    const authProfilesManager = {
      getBestProfile: async () => null,
    } as never;
    return new ClaudeOAuthModule(authProfilesManager, {} as never);
  }

  test("uses ANTHROPIC_API_KEY (x-api-key) and returns the newest model", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test";
    let sentAuthHeader: string | undefined;
    let sentApiKeyHeader: string | undefined;
    globalThis.fetch = (async (_url, init) => {
      const h = (init?.headers as Record<string, string>) ?? {};
      sentAuthHeader = h.Authorization;
      sentApiKeyHeader = h["x-api-key"];
      return new Response(
        JSON.stringify({
          data: [
            { id: "claude-newest-1", display_name: "Newest", type: "model" },
            { id: "claude-older-2", display_name: "Older", type: "model" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof globalThis.fetch;

    const model = await makeModule().getDefaultModel("agent-1");

    expect(model).toBe("claude-newest-1");
    expect(sentApiKeyHeader).toBe("sk-ant-api03-test");
    expect(sentAuthHeader).toBeUndefined();
  });

  test("uses ANTHROPIC_AUTH_TOKEN as a Bearer token, not x-api-key", async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-ant-oat-bearer";
    let sentAuthHeader: string | undefined;
    let sentApiKeyHeader: string | undefined;
    globalThis.fetch = (async (_url, init) => {
      const h = (init?.headers as Record<string, string>) ?? {};
      sentAuthHeader = h.Authorization;
      sentApiKeyHeader = h["x-api-key"];
      return new Response(
        JSON.stringify({ data: [{ id: "claude-x", type: "model" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof globalThis.fetch;

    const model = await makeModule().getDefaultModel("agent-1");

    expect(model).toBe("claude-x");
    expect(sentAuthHeader).toBe("Bearer sk-ant-oat-bearer");
    expect(sentApiKeyHeader).toBeUndefined();
  });

  test("no credentials → undefined (no model, surfaces 'connect a provider')", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;

    const model = await makeModule().getDefaultModel("agent-1");

    expect(model).toBeUndefined();
    expect(fetched).toBe(false);
  });
});
