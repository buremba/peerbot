import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SecretStore } from "../secrets/index.js";

/**
 * End-to-end proof that an org-owned inference-provider slug, once its upstream
 * is registered on the SecretProxy (as ProviderCatalogService does when it
 * synthesizes the module), ROUTES through the URL invariant to the org's custom
 * base_url with the org row's key — never a profile/env credential.
 *
 * The store is mocked (no DB): resolveInferenceProviderConfig returns a custom
 * text upstream + org key, so resolveUrlInvariant yields `org-only`. We then
 * drive a real request through the proxy's Hono app and inspect the outbound
 * fetch. This mirrors inference-url-invariant.test.ts's store-mock pattern but
 * exercises the full secret-proxy egress path.
 */

let inferenceConfig: {
  baseUrl?: string;
  apiKey?: string;
  custom: boolean;
};

// Custom upstream + usable org key ⇒ resolveUrlInvariant returns org-only.
// Spread the real module so secret-proxy's other imports from it (e.g.
// readOrgSharedProviderApiKey) still resolve; override only the resolver.
const realProviderSecrets = await import(
  "../../lobu/stores/provider-secrets.js"
);
mock.module("../../lobu/stores/provider-secrets.js", () => ({
  ...realProviderSecrets,
  resolveInferenceProviderConfig: async () => inferenceConfig,
}));

// Import AFTER the mock so secret-proxy's transitive import of the invariant
// (which imports the store) picks up the stub.
const { SecretProxy } = await import("../proxy/secret-proxy.js");

describe("SecretProxy — org custom-upstream slug routing (URL invariant)", () => {
  beforeEach(() => {
    inferenceConfig = {
      baseUrl: "https://myzai.example.com/v1",
      apiKey: "org-myzai-key",
      custom: true,
    };
  });

  test("registered org slug routes to the row base_url with the org key", async () => {
    const proxy = new SecretProxy(
      { defaultUpstreamUrl: "https://default.example.com" },
      { get: async () => null } satisfies SecretStore
    );

    // This is exactly what ProviderCatalogService does for a synthesized org
    // module: register the upstream so slugMap + slugToProviderId know it.
    proxy.registerUpstream(
      { slug: "myzai", upstreamBaseUrl: "https://myzai.example.com/v1" },
      "myzai"
    );

    // The invariant path is gated on slugToProviderId AND authProfilesManager.
    proxy.setAuthProfilesManager({
      // Should NOT be consulted on the org-only path (fail-closed to the row key).
      getBestProfile: async () => {
        throw new Error("profile lookup must not run on org-only path");
      },
      ensureFreshCredential: async () => undefined,
    } as never);
    // Independent source of the caller's org for the invariant lookup.
    proxy.setAgentOrgResolver(async () => "org-1");

    let capturedUrl: string | null = null;
    let capturedAuth: string | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      capturedUrl = typeof input === "string" ? input : String(input);
      capturedAuth =
        (init?.headers as Record<string, string>)?.authorization ?? null;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      const res = await proxy
        .getApp()
        .request("/api/proxy/myzai/a/agent-1/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer worker-token-test",
          },
          body: JSON.stringify({ model: "myzai/glm-4.6", prompt: "hi" }),
        });

      expect(res.status).toBe(200);
      // Routed to the tenant-defined URL from the row (NOT the static default).
      expect(capturedUrl).toBe(
        "https://myzai.example.com/v1/v1/chat/completions"
      );
      // Authenticated with the org row's key (Bearer for openai-compat).
      expect(capturedAuth).toBe("Bearer org-myzai-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("catalog upstream uses the inference-provider row key", async () => {
    inferenceConfig = {
      apiKey: "org-zai-key",
      custom: false,
    };
    const proxy = new SecretProxy(
      { defaultUpstreamUrl: "https://default.example.com" },
      { get: async () => null } satisfies SecretStore
    );
    proxy.registerUpstream(
      { slug: "z-ai", upstreamBaseUrl: "https://api.z.ai/api/paas/v4" },
      "z-ai"
    );
    proxy.setAuthProfilesManager({
      getBestProfile: async () => {
        throw new Error("profile lookup must not run when the org row has a key");
      },
      ensureFreshCredential: async () => undefined,
    } as never);
    proxy.setAgentOrgResolver(async () => "org-1");

    let capturedUrl: string | null = null;
    let capturedAuth: string | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      capturedUrl = typeof input === "string" ? input : String(input);
      capturedAuth =
        (init?.headers as Record<string, string>)?.authorization ?? null;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      const res = await proxy
        .getApp()
        .request("/api/proxy/z-ai/a/agent-1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer worker-token-test",
          },
          body: JSON.stringify({ model: "glm-5.2", prompt: "hi" }),
        });

      expect(res.status).toBe(200);
      expect(capturedUrl).toBe(
        "https://api.z.ai/api/paas/v4/chat/completions"
      );
      expect(capturedAuth).toBe("Bearer org-zai-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
