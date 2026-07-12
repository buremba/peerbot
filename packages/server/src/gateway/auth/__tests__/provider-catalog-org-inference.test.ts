import { afterEach, describe, expect, test } from "bun:test";
import { type ModuleInterface, moduleRegistry } from "@lobu/core";
import type { InferenceProviderListItem } from "../../../lobu/stores/provider-secrets.js";
import type { ApiKeyProviderModule } from "../api-key-provider-module.js";
import { ProviderCatalogService } from "../provider-catalog.js";

/**
 * Register a fake catalog module so buildProviderCatalog() (called inside
 * getInstalledModules to map an org row's `kind` → protocol) can resolve it.
 * Keyed by `name`; the registry only stores enabled modules.
 */
function registerFakeModule(
  providerId: string,
  sdkCompat: string,
  opts: { hasSystemKey?: boolean } = {}
): void {
  moduleRegistry.register({
    name: `${providerId}-provider`,
    isEnabled: () => true,
    providerId,
    providerDisplayName: providerId,
    providerIconUrl: "",
    authType: "oauth",
    sdkCompat,
    hasSystemKey: () => opts.hasSystemKey ?? false,
    getSecretEnvVarNames: () => [],
  } as unknown as ModuleInterface);
}

function clearRegistry(): void {
  (
    moduleRegistry as unknown as { modules: Map<string, ModuleInterface> }
  ).modules = new Map();
}

/**
 * Org-owned inference-provider slugs (rows in `inference_providers`) must become
 * ROUTABLE worker model providers: an agent with `models: ["<orgSlug>/<model>"]`
 * routes through the gateway proxy to the org's custom `capabilities.text.base_url`.
 *
 * getInstalledModules resolves the agent's `models` list (ordered explicit
 * `<slug>/<model>` refs) into modules: a slug that isn't a providers.json module
 * but matches a custom-upstream org row is synthesized into an
 * ApiKeyProviderModule. The org KEY is never read here — it is injected at
 * egress by resolveUrlInvariant; the synthetic module only makes the slug appear
 * in the worker provider config and the proxy slug maps. Registration happens
 * per-pod, hydrated from the row (multi-replica safe: no shared in-memory map
 * another replica must read).
 *
 * These tests inject the store reader + registerUpstream callback and a fake
 * settings store, so no DB/proxy wiring is required.
 */

function makeCatalog(opts: {
  models: string[] | undefined;
  orgRows?: InferenceProviderListItem[];
  registerUpstream?: (
    upstream: { slug: string; upstreamBaseUrl: string },
    providerId: string
  ) => void;
  withOrgReader?: boolean;
}): ProviderCatalogService {
  const agentSettingsStore = {
    getSettings: async () => ({
      models: opts.models,
    }),
  } as never;
  // findProviderForModel probes each module's getModelOptions, which resolves
  // credentials through the profiles manager — stub it to "no profile".
  const authProfilesManager = { getBestProfile: async () => null } as never;
  const listOrgInferenceProviders =
    opts.withOrgReader === false ? undefined : async () => opts.orgRows ?? [];
  return new ProviderCatalogService(
    agentSettingsStore,
    authProfilesManager,
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
  afterEach(() => clearRegistry());

  test("synthesizes a routable module for a custom-upstream org slug + registers its upstream", async () => {
    const registered: Array<{ slug: string; providerId: string; url: string }> =
      [];
    const catalog = makeCatalog({
      models: ["myzai/glm-4.6"],
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

  test("an org row whose kind is an anthropic provider routes as anthropic (x-api-key)", async () => {
    // Claude-like catalog module so kind "claude" resolves to sdkCompat anthropic.
    registerFakeModule("claude", "anthropic");
    const catalog = makeCatalog({
      models: ["my-claude/claude-x"],
      orgRows: [customUpstreamRow("my-claude", { kind: "claude" })],
      registerUpstream: () => {},
    });

    const modules = await catalog.getInstalledModules("agent-1", "org-1");
    expect(modules).toHaveLength(1);
    const mod = modules[0] as ApiKeyProviderModule;

    // Protocol resolved from the row's kind → anthropic, not the default openai.
    expect(mod.getProviderMetadata()?.sdkCompat).toBe("anthropic");
    // Anthropic keys must present as x-api-key, not Bearer — the proxy reads
    // this off the upstream config at egress.
    expect(mod.getUpstreamConfig()?.apiKeyHeader).toBe("x-api-key");
  });

  test("does NOT synthesize when the org row has no custom text base_url", async () => {
    const registered: string[] = [];
    const catalog = makeCatalog({
      models: ["myzai/glm-4.6"],
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
      models: ["myzai/glm-4.6"],
      orgRows: [customUpstreamRow("myzai")],
    });
    // Wrap to detect that the reader is never consulted without an org.
    (
      catalog as never as { listOrgInferenceProviders?: unknown }
    ).listOrgInferenceProviders = async () => {
      readerCalled = true;
      return [customUpstreamRow("myzai")];
    };

    const modules = await catalog.getInstalledModules("agent-1");
    expect(modules).toHaveLength(0);
    expect(readerCalled).toBe(false);
  });

  test("preserves models order and drops unmatched slugs", async () => {
    // Two org-synthesized slugs plus one models entry with NO matching row.
    // The unmatched slug is dropped (as a non-providers.json slug always was),
    // and the two synthesized modules keep the models-list order.
    const catalog = makeCatalog({
      models: ["myzai/glm-4.6", "no-such-provider/x", "acme/m-1"],
      orgRows: [customUpstreamRow("acme"), customUpstreamRow("myzai")],
    });
    const modules = await catalog.getInstalledModules("agent-1", "org-1");
    const ids = modules.map((m) => m.providerId);
    // models order preserved (myzai before acme); unmatched slug dropped.
    expect(ids).toEqual(["myzai", "acme"]);
  });

  test("dedups slugs by first appearance across multiple models of one provider", async () => {
    const catalog = makeCatalog({
      models: ["myzai/glm-4.6", "myzai/glm-5.2", "acme/m-1"],
      orgRows: [customUpstreamRow("acme"), customUpstreamRow("myzai")],
    });
    const modules = await catalog.getInstalledModules("agent-1", "org-1");
    expect(modules.map((m) => m.providerId)).toEqual(["myzai", "acme"]);
  });

  test("decision B: does NOT append the org default to a non-empty list", async () => {
    const catalog = makeCatalog({
      models: ["myzai/glm-4.6"],
      orgRows: [
        customUpstreamRow("myzai"),
        customUpstreamRow("acme", { isDefault: true }),
      ],
    });
    const modules = await catalog.getInstalledModules("agent-1", "org-1");
    // The org default (acme) is NOT reachable — only the listed slug resolves.
    expect(modules.map((m) => m.providerId)).toEqual(["myzai"]);
  });

  test("GATE: an org provider NOT in the agent's non-empty models list does not resolve", async () => {
    // "acme" is org-installed (a live inference_providers row) but the agent's
    // models list names only "myzai" — so acme must NOT be routable for this
    // agent. Decision B: NO org-default tail — only the listed slugs resolve.
    const catalog = makeCatalog({
      models: ["myzai/glm-4.6"],
      orgRows: [
        customUpstreamRow("myzai", { isDefault: true }),
        customUpstreamRow("acme"),
      ],
    });
    const modules = await catalog.getInstalledModules("agent-1", "org-1");
    expect(modules.map((m) => m.providerId)).toEqual(["myzai"]);

    // The resolver finds no provider for an out-of-list model ref.
    const provider = await catalog.findProviderForModel("acme/some-model", modules);
    expect(provider).toBeUndefined();
  });

  test("EMPTY models list ⇒ all org rows (default first) plus system-key registry modules", async () => {
    // Decision: an agent with no models list gets every org provider — the org
    // default row first, the remaining org rows, then every registry module
    // with a deployment/system key not already covered.
    registerFakeModule("housekey", "openai", { hasSystemKey: true });
    registerFakeModule("keyless", "openai", { hasSystemKey: false });
    const catalog = makeCatalog({
      models: [],
      orgRows: [
        customUpstreamRow("myzai"),
        customUpstreamRow("acme", { isDefault: true }),
      ],
    });
    const modules = await catalog.getInstalledModules("agent-1", "org-1");
    const ids = modules.map((m) => m.providerId);
    // Org default first, then remaining org rows, then system-key modules.
    expect(ids).toEqual(["acme", "myzai", "housekey"]);
    // A registry module WITHOUT a system key is not exposed.
    expect(ids).not.toContain("keyless");
  });

  test("ABSENT models (undefined) behaves like the empty list", async () => {
    registerFakeModule("housekey", "openai", { hasSystemKey: true });
    const catalog = makeCatalog({
      models: undefined,
      orgRows: [customUpstreamRow("acme", { isDefault: true })],
    });
    const modules = await catalog.getInstalledModules("agent-1", "org-1");
    expect(modules.map((m) => m.providerId)).toEqual(["acme", "housekey"]);
  });
});

describe("ProviderCatalogService.getModelPolicy — exact allow-list", () => {
  afterEach(() => clearRegistry());

  test("non-empty list ⇒ allowedRefs is EXACTLY the listed refs (decision B: NO org-default tail)", async () => {
    const catalog = makeCatalog({
      models: ["myzai/glm-4.6"],
      orgRows: [
        // acme is the org default but must NOT leak into allowedRefs/modules.
        customUpstreamRow("acme", { isDefault: true }),
        customUpstreamRow("myzai"),
      ],
    });
    const { allowedRefs, modules } = await catalog.getModelPolicy(
      "agent-1",
      "org-1"
    );
    // Exactly the listed ref — no org-default concrete ref appended.
    expect(allowedRefs).toEqual(["myzai/glm-4.6"]);
    // Modules cover ONLY the listed provider — the org default is not added.
    expect(modules.map((m) => m.providerId)).toEqual(["myzai"]);
  });

  test("decision B: a sentinel-only list resolves to zero routable modules (hard fail closed)", async () => {
    // models = ["chatgpt/__unresolved__"] is the "restricted but nothing
    // resolvable yet" state: the allow-list contains only the sentinel, and no
    // real module routes it — findProviderForModel refuses the sentinel.
    registerFakeModule("chatgpt", "openai", { hasSystemKey: true });
    const catalog = makeCatalog({
      models: ["chatgpt/__unresolved__"],
      orgRows: [],
    });
    const { allowedRefs, modules } = await catalog.getModelPolicy(
      "agent-1",
      "org-1"
    );
    expect(allowedRefs).toEqual(["chatgpt/__unresolved__"]);
    // #2(a): the sentinel's slug MUST NOT contribute a provider module — even
    // though a credentialed chatgpt module exists in the registry. Zero modules
    // means session-context has nothing to fall back to → hard fail closed.
    expect(modules).toHaveLength(0);
    // And findProviderForModel refuses the sentinel ref outright.
    const provider = await catalog.findProviderForModel(
      "chatgpt/__unresolved__",
      modules
    );
    expect(provider).toBeUndefined();
  });

  test("#2(a): a MIXED list exposes the real provider's module but NOT the sentinel's", async () => {
    // models=["ghost/__unresolved__","myzai/glm-4.6"]. The real provider (myzai)
    // routes; the sentinel's slug (ghost) contributes NO module.
    const catalog = makeCatalog({
      models: ["ghost/__unresolved__", "myzai/glm-4.6"],
      orgRows: [customUpstreamRow("myzai", { isDefault: true })],
    });
    const { allowedRefs, modules } = await catalog.getModelPolicy(
      "agent-1",
      "org-1"
    );
    // The sentinel stays in the exact allow-list (it's a listed entry)…
    expect(allowedRefs).toEqual(["ghost/__unresolved__", "myzai/glm-4.6"]);
    // …but only the real provider resolves a module.
    expect(modules.map((m) => m.providerId)).toEqual(["myzai"]);
  });

  test("GATE is EXACT: a different model on a LISTED provider is NOT allowed", async () => {
    const catalog = makeCatalog({
      models: ["myzai/glm-4.6"],
      orgRows: [customUpstreamRow("myzai", { isDefault: true })],
    });
    const { allowedRefs } = await catalog.getModelPolicy("agent-1", "org-1");
    // The provider is myzai but "myzai/other" is a DIFFERENT model → excluded.
    expect(allowedRefs).toContain("myzai/glm-4.6");
    expect(allowedRefs).not.toContain("myzai/other");
  });

  test("empty list ⇒ allowedRefs is null (allow-all)", async () => {
    const catalog = makeCatalog({
      models: [],
      orgRows: [customUpstreamRow("acme", { isDefault: true })],
    });
    const { allowedRefs } = await catalog.getModelPolicy("agent-1", "org-1");
    expect(allowedRefs).toBeNull();
  });

  test("multiple same-provider entries are BOTH in the exact allow-list (ordered)", async () => {
    // The gate must permit each listed model of one provider — this is what
    // lets models[1..] act as ordered same-provider fallbacks.
    const catalog = makeCatalog({
      models: ["myzai/glm-4.6", "myzai/glm-5.2"],
      orgRows: [customUpstreamRow("myzai", { isDefault: true })],
    });
    const { allowedRefs } = await catalog.getModelPolicy("agent-1", "org-1");
    expect(allowedRefs?.[0]).toBe("myzai/glm-4.6");
    expect(allowedRefs).toContain("myzai/glm-5.2");
  });
});

describe("ProviderCatalogService.getModelPolicy — not-found / orgless are DENY-ALL (R5 #2/#4)", () => {
  afterEach(() => clearRegistry());

  function makeCatalogWithSettings(settings: {
    getSettings: (agentId: string, ctx?: { organizationId?: string }) => Promise<unknown>;
    isDeclaredAgent?: (agentId: string) => boolean;
  }): ProviderCatalogService {
    return new ProviderCatalogService(
      settings as never,
      { getBestProfile: async () => null } as never,
      (async () => []) as never,
      (() => {}) as never
    );
  }

  test("R5 #2: a NOT-FOUND agent (getSettings→null) is DENY-ALL (allowedRefs=[], zero modules)", async () => {
    // Register a system-key module: if this were allow-all it would leak here.
    registerFakeModule("housekey", "openai", { hasSystemKey: true });
    const catalog = makeCatalogWithSettings({
      getSettings: async () => null,
    });
    const { allowedRefs, modules } = await catalog.getModelPolicy(
      "ghost-agent",
      "org-1"
    );
    expect(allowedRefs).toEqual([]); // deny-all, NOT null (allow-all)
    expect(modules).toHaveLength(0);

    // Any requested model fails closed.
    const resolved = await catalog.resolveDispatchModel(
      "ghost-agent",
      "org-1",
      "openai/gpt-5"
    );
    expect(resolved.model).toBeUndefined();
    expect(resolved.replaced).toBe(true);
  });

  test("R5 #4: an ORGLESS db-backed read is DENY-ALL (no id-only cross-org lookup)", async () => {
    registerFakeModule("housekey", "openai", { hasSystemKey: true });
    let getSettingsCalled = false;
    const catalog = makeCatalogWithSettings({
      getSettings: async () => {
        getSettingsCalled = true;
        // Even if the store WOULD return another org's list, the resolver must
        // refuse the orgless read before this runs.
        return { models: ["claude/other-org-model"] };
      },
      isDeclaredAgent: () => false,
    });
    const { allowedRefs, modules } = await catalog.getModelPolicy(
      "lobu-builder",
      undefined // no org
    );
    expect(allowedRefs).toEqual([]);
    expect(modules).toHaveLength(0);
    // The DB read was never attempted for the orgless db-backed agent.
    expect(getSettingsCalled).toBe(false);
  });

  test("R5 #4: an ORGLESS DECLARED agent still resolves its org-agnostic policy", async () => {
    const catalog = makeCatalogWithSettings({
      getSettings: async () => ({ models: ["openai/gpt-5"] }),
      isDeclaredAgent: () => true, // declared/SDK-embedded → org-agnostic
    });
    const { allowedRefs } = await catalog.getModelPolicy(
      "declared-agent",
      undefined
    );
    expect(allowedRefs).toEqual(["openai/gpt-5"]);
  });

  test("a present agent with an EMPTY models list keeps ALLOW-ALL (null)", async () => {
    registerFakeModule("housekey", "openai", { hasSystemKey: true });
    const catalog = makeCatalogWithSettings({
      getSettings: async () => ({ models: [] }),
    });
    const { allowedRefs } = await catalog.getModelPolicy("agent-1", "org-1");
    expect(allowedRefs).toBeNull(); // allow-all preserved — NOT collapsed to deny
  });
});
