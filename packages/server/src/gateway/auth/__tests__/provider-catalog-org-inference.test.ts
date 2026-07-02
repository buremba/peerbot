import { describe, expect, test } from "bun:test";
import type { InferenceProviderListItem } from "../../../lobu/stores/provider-secrets.js";
import type { ApiKeyProviderModule } from "../api-key-provider-module.js";
import { ProviderCatalogService } from "../provider-catalog.js";

/**
 * Org-owned inference-provider slugs (rows in `inference_providers`) must become
 * ROUTABLE worker model providers: an agent with `model: "<orgSlug>/<model>"`
 * routes through the gateway proxy to the org's custom `capabilities.text.base_url`.
 *
 * getInstalledModules synthesizes an ApiKeyProviderModule for any installed slug
 * that isn't a providers.json module but matches a custom-upstream org row. The
 * org KEY is never read here — it is injected at egress by resolveUrlInvariant;
 * the synthetic module only makes the slug appear in the worker provider config
 * and the proxy slug maps. Registration happens per-pod, hydrated from the row
 * (multi-replica safe: no shared in-memory map another replica must read).
 *
 * These tests inject the store reader + registerUpstream callback and a fake
 * settings store, so no DB/proxy wiring is required.
 */

function makeCatalog(opts: {
  installedProviderIds: string[];
  orgRows?: InferenceProviderListItem[];
  registerUpstream?: (
    upstream: { slug: string; upstreamBaseUrl: string },
    providerId: string
  ) => void;
  withOrgReader?: boolean;
}): ProviderCatalogService {
  const agentSettingsStore = {
    getSettings: async () => ({
      installedProviders: opts.installedProviderIds.map((providerId) => ({
        providerId,
        installedAt: 1,
      })),
    }),
  } as never;
  const authProfilesManager = {} as never;
  const declaredAgents = { has: () => false } as never;
  const listOrgInferenceProviders =
    opts.withOrgReader === false
      ? undefined
      : async () => opts.orgRows ?? [];
  return new ProviderCatalogService(
    agentSettingsStore,
    authProfilesManager,
    declaredAgents,
    listOrgInferenceProviders as never,
    opts.registerUpstream as never
  );
}

function customUpstreamRow(
  slug: string,
  overrides?: Partial<InferenceProviderListItem>
): InferenceProviderListItem {
  return {
    id: 1,
    slug,
    kind: "openai",
    displayName: `${slug} display`,
    capabilities: {
      text: { base_url: `https://${slug}.example.com/v1`, model: "glm-4.6" },
    },
    hasCustomUpstream: true,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ProviderCatalogService.getInstalledModules — org inference providers", () => {
  test("synthesizes a routable module for a custom-upstream org slug + registers its upstream", async () => {
    const registered: Array<{ slug: string; providerId: string; url: string }> =
      [];
    const catalog = makeCatalog({
      installedProviderIds: ["myzai"],
      orgRows: [customUpstreamRow("myzai")],
      registerUpstream: (upstream, providerId) =>
        registered.push({
          slug: upstream.slug,
          providerId,
          url: upstream.upstreamBaseUrl,
        }),
    });

    const modules = await catalog.getInstalledModules("agent-1", "org-1");
    expect(modules).toHaveLength(1);
    const mod = modules[0] as ApiKeyProviderModule;
    expect(mod.providerId).toBe("myzai");

    // getUpstreamConfig() returns {slug, upstreamBaseUrl} matching the row.
    const upstream = mod.getUpstreamConfig();
    expect(upstream).toEqual({
      slug: "myzai",
      upstreamBaseUrl: "https://myzai.example.com/v1",
      apiKeyHeader: undefined,
    });

    // getProviderMetadata() advertises openai sdkCompat + the row's defaultModel.
    const meta = mod.getProviderMetadata();
    expect(meta?.sdkCompat).toBe("openai");
    expect(meta?.defaultModel).toBe("glm-4.6");

    // The slug was registered on the proxy so it becomes routable.
    expect(registered).toEqual([
      {
        slug: "myzai",
        providerId: "myzai",
        url: "https://myzai.example.com/v1",
      },
    ]);

    // Never surfaced in the "Add Provider" catalog.
    expect(mod.catalogVisible).toBe(false);
  });

  test("does NOT synthesize when the org row has no custom text base_url", async () => {
    const registered: string[] = [];
    const catalog = makeCatalog({
      installedProviderIds: ["myzai"],
      orgRows: [
        customUpstreamRow("myzai", {
          capabilities: {},
          hasCustomUpstream: false,
        }),
      ],
      registerUpstream: (u) => registered.push(u.slug),
    });

    const modules = await catalog.getInstalledModules("agent-1", "org-1");
    expect(modules).toHaveLength(0);
    expect(registered).toEqual([]);
  });

  test("does NOT synthesize when organizationId is absent (slug dropped as before)", async () => {
    let readerCalled = false;
    const catalog = makeCatalog({
      installedProviderIds: ["myzai"],
      orgRows: [customUpstreamRow("myzai")],
    });
    // Wrap to detect that the reader is never consulted without an org.
    (catalog as never as { listOrgInferenceProviders?: unknown }).listOrgInferenceProviders =
      async () => {
        readerCalled = true;
        return [customUpstreamRow("myzai")];
      };

    const modules = await catalog.getInstalledModules("agent-1");
    expect(modules).toHaveLength(0);
    expect(readerCalled).toBe(false);
  });

  test("preserves install order and drops unmatched slugs", async () => {
    // Two org-synthesized slugs plus one installed slug with NO matching row.
    // The unmatched slug is dropped (as a non-providers.json slug always was),
    // and the two synthesized modules keep installedProviders order.
    const catalog = makeCatalog({
      installedProviderIds: ["myzai", "no-such-provider", "acme"],
      orgRows: [customUpstreamRow("acme"), customUpstreamRow("myzai")],
    });
    const modules = await catalog.getInstalledModules("agent-1", "org-1");
    const ids = modules.map((m) => m.providerId);
    // Install order preserved (myzai before acme); unmatched slug dropped.
    expect(ids).toEqual(["myzai", "acme"]);
  });
});
