import {
  createLogger,
  isSdkCompat,
  type ProviderConfigEntry,
  SDK_COMPAT_PROTOCOLS,
  type SdkCompat,
} from "@lobu/core";
import type { InferenceProviderListItem } from "../../lobu/stores/provider-secrets.js";
import {
  getModelProviderModules,
  type ModelProviderModule,
  type ProviderUpstreamConfig,
} from "../modules/module-system.js";
import { ApiKeyProviderModule } from "./api-key-provider-module.js";
import {
  isUnresolvedModelRef,
  UNRESOLVED_MODEL_SUFFIX,
} from "./model-sentinel.js";
import type { AgentSettingsStore } from "./settings/agent-settings-store.js";
import type { AuthProfilesManager } from "./settings/auth-profiles-manager.js";
import { enforceModelAllowList } from "./settings/model-selection.js";

const logger = createLogger("provider-catalog");

// Re-export the sentinel helpers so existing importers keep working.
export { isUnresolvedModelRef, UNRESOLVED_MODEL_SUFFIX };

/** Auth mechanism a provider supports. */
export type ProviderAuthType = "oauth" | "device-code" | "api-key";

/**
 * One provider as seen in the "Add provider" catalog: its identity, auth
 * options (OAuth sign-in vs API key), wire protocol (`sdkCompat`), and upstream
 * pre-fill. Built from the module registry so EVERY registered provider appears
 * — the config-driven api-key ones AND the hardcoded OAuth ones (Claude,
 * ChatGPT) — not just the providers.json subset.
 */
export interface ProviderCatalogEntry {
  /** Provider id; also the default slug pre-fill. */
  slug: string;
  displayName: string;
  iconUrl: string;
  authType: ProviderAuthType;
  supportedAuthTypes: ProviderAuthType[];
  /**
   * Wire protocol the provider speaks. "openai" for the config-driven OpenAI-
   * compatible providers; null when unknown/not-yet-routable (the OAuth
   * providers — their real protocol is wired in a later phase).
   */
  sdkCompat: string | null;
  /** Upstream base URL pre-fill ("" when the module doesn't expose one). */
  baseUrl: string;
  defaultModel: string | null;
  modelsEndpoint: string | null;
  /** True when this deployment has a process-level credential for the provider. */
  systemAvailable: boolean;
  /**
   * Static fallback model IDs (from providers.json), used by the model picker
   * when a provider has no live `modelsEndpoint` or the live fetch is empty.
   */
  models: string[];
  apiKeyPlaceholder: string;
  apiKeyInstructions: string;
  /** Modalities served; drives which per-modality overrides the UI offers. */
  modalities: ("text" | "image" | "stt" | "tts")[];
}

/**
 * Build the provider catalog from the module registry. This is the single
 * source of truth both the org inference-providers catalog route and the
 * per-agent agent-config catalog map from — so Claude/ChatGPT (OAuth modules)
 * appear everywhere, carrying their auth metadata.
 *
 * `configs` (the flattened providers.json map, keyed by providerId) enriches
 * the config-driven entries with sdkCompat/defaultModel/modelsEndpoint/
 * modalities. It's optional: callers without a registry handle (agent-config,
 * which only needs the auth fields) may omit it — those entries then fall back
 * to the module's own metadata and default to text-only.
 */
export function buildProviderCatalog(
  configs?: Record<string, ProviderConfigEntry>
): ProviderCatalogEntry[] {
  const entries: ProviderCatalogEntry[] = [];
  for (const module of getModelProviderModules()) {
    if (module.catalogVisible === false) continue;
    try {
      const config = configs?.[module.providerId];

      const authType = (module.authType || "oauth") as ProviderAuthType;
      const supportedAuthTypes =
        (module.supportedAuthTypes as ProviderAuthType[] | undefined) ?? [
          authType,
        ];

      // sdkCompat/defaultModel come from providers.json when we have it, else
      // from the module's own metadata (config-driven modules expose it), else
      // from the module's declared protocol (OAuth modules like Claude set
      // `sdkCompat` directly since they aren't config-driven).
      const moduleMeta =
        module instanceof ApiKeyProviderModule
          ? module.getProviderMetadata()
          : null;
      const sdkCompat =
        config?.sdkCompat ?? moduleMeta?.sdkCompat ?? module.sdkCompat ?? null;
      const defaultModel =
        config?.defaultModel ?? moduleMeta?.defaultModel ?? null;

      const upstream =
        module instanceof ApiKeyProviderModule
          ? module.getUpstreamConfig()
          : null;
      const baseUrl = config?.upstreamBaseUrl ?? upstream?.upstreamBaseUrl ?? "";

      entries.push({
        slug: module.providerId,
        displayName: config?.displayName || module.providerDisplayName,
        iconUrl: config?.iconUrl || module.providerIconUrl || "",
        authType,
        supportedAuthTypes,
        sdkCompat,
        baseUrl,
        defaultModel,
        modelsEndpoint: config?.modelsEndpoint ?? null,
        systemAvailable: module.hasSystemKey?.() ?? false,
        models: config?.models ?? module.catalogModels ?? [],
        apiKeyPlaceholder:
          config?.apiKeyPlaceholder ?? module.apiKeyPlaceholder ?? "",
        apiKeyInstructions:
          config?.apiKeyInstructions ?? module.apiKeyInstructions ?? "",
        modalities: config?.modalities ?? ["text"],
      });
    } catch (err) {
      logger.warn(
        {
          providerId: module.providerId,
          err: err instanceof Error ? err.message : String(err),
        },
        "[buildProviderCatalog] skipping malformed provider module"
      );
    }
  }
  entries.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return entries;
}

/**
 * Reads an org's inference-provider rows (slug + custom-upstream capabilities).
 * Injected so ProviderCatalogService can synthesize routable modules for
 * org-defined provider slugs without depending on the store directly.
 */
export type OrgInferenceProviderReader = (
  organizationId: string
) => Promise<InferenceProviderListItem[]>;

/**
 * Registers a synthesized org provider's upstream on the secret proxy so the
 * slug becomes routable (populates slugMap + slugToProviderId). Injected from
 * core-services, which owns the SecretProxy instance.
 */
export type RegisterUpstreamFn = (
  upstream: ProviderUpstreamConfig,
  providerId: string
) => void;

/**
 * Build the synthetic env var name for an org provider slug. The value is never
 * read (the org key is supplied at egress by resolveUrlInvariant), but
 * BaseProviderModule needs a stable, collision-free credential env var name.
 */
function orgProviderKeyEnvVarName(slug: string): string {
  return `LOBU_ORG_PROVIDER_${slug.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`;
}

/**
 * The THREE distinct model-policy states — kept distinct so the caller can map
 * each to the right allow-list semantics (a fail-open bug conflated the first
 * two into allow-all):
 *   - `not-found`   : no agent row (or a cross-org / cross-tenant refusal) →
 *                     the caller must DENY ALL (empty allow-list, zero modules).
 *   - `unrestricted`: the agent exists with an EMPTY/absent `models` list → the
 *                     deliberate allow-all policy.
 *   - `restricted`  : the agent has a non-empty `models` list → the exact refs.
 */
type AgentModelPolicy =
  | { kind: "not-found" }
  | { kind: "unrestricted" }
  | { kind: "restricted"; models: string[] };

/**
 * Resolve an agent's ordered `models` list into one of the three policy states.
 *
 * REFUSES an id-only cross-org read: when `organizationId` is undefined the read
 * is NOT org-scoped, and a shared agent id (e.g. "lobu-builder") lives in many
 * orgs — an id-only match could read ANOTHER tenant's models list. For a
 * policy-enforcement read that is a cross-tenant leak, so we return `not-found`
 * (deny) rather than risk it. (Declared/SDK-embedded agents are resolved by the
 * settings store BEFORE any DB scope, so their org-agnostic settings still
 * resolve; only the DB-backed path requires org.)
 */
async function resolveAgentModels(
  agentSettingsStore: AgentSettingsStore,
  agentId: string,
  organizationId?: string
): Promise<AgentModelPolicy> {
  // Declared (SDK-embedded) agents have org-agnostic settings; getSettings
  // resolves them without a DB scope, so an orgless declared-agent turn still
  // reads its REAL policy (not a cross-org DB row). The check is ORG-AWARE: a
  // declared id that ALSO has a real DB row in the given org is treated as
  // DB-backed (the DB row wins), so a collision never flips the orgless guard
  // open for a tenant's agent.
  const isDeclared = agentSettingsStore.isDeclaredAgentScoped
    ? await agentSettingsStore.isDeclaredAgentScoped(agentId, organizationId)
    : (agentSettingsStore.isDeclaredAgent?.(agentId) ?? false);

  // A DB-backed agent policy read MUST be org-scoped. Without an org, refuse the
  // id-only fallback (a shared id like "lobu-builder" would read another org's
  // row — a cross-tenant leak) and DENY.
  if (!isDeclared && !organizationId) {
    return { kind: "not-found" };
  }

  const settings = await agentSettingsStore.getSettings(agentId, {
    organizationId,
  });
  // NULL settings = the agent row does not exist in THIS org (or the agent-org
  // pair mismatched). Not-found MUST deny-all, never collapse to allow-all.
  if (!settings) return { kind: "not-found" };
  return settings.models && settings.models.length > 0
    ? { kind: "restricted", models: settings.models }
    : { kind: "unrestricted" };
}

/**
 * ProviderCatalogService wraps the module registry to provide
 * per-agent provider install/uninstall/reorder operations.
 *
 * Providers are registered globally in the module registry,
 * but each agent chooses which providers to install from the catalog.
 */
export class ProviderCatalogService {
  constructor(
    private agentSettingsStore: AgentSettingsStore,
    private authProfilesManager: AuthProfilesManager,
    /**
     * Reads the org's inference_providers rows. When present, an installed
     * provider slug that isn't a providers.json module is synthesized from a
     * matching custom-upstream row (see getInstalledModules).
     */
    private listOrgInferenceProviders?: OrgInferenceProviderReader,
    /**
     * Registers a synthesized org module's upstream on the secret proxy so the
     * slug routes. Called just-in-time from getInstalledModules — per-pod,
     * hydrated from the row, so it stays correct under N>1 replicas (no shared
     * in-memory state another pod must read).
     */
    private registerUpstream?: RegisterUpstreamFn
  ) {}

  /**
   * Synthesize a routable provider module for an org-defined inference-provider
   * slug that has a custom text upstream. Reuses ApiKeyProviderModule — the org
   * key itself is NOT read here; it is injected at egress by resolveUrlInvariant
   * (org-only). This module only makes the slug appear in the worker's provider
   * config + the proxy's slug maps. Returns null when the row has no custom
   * `capabilities.text.base_url` (nothing to route to).
   */
  private synthesizeOrgProviderModule(
    row: InferenceProviderListItem,
    sdkCompat: SdkCompat
  ): ApiKeyProviderModule | null {
    const textUpstream = row.capabilities.text?.base_url;
    if (!textUpstream) return null;

    const module = new ApiKeyProviderModule({
      providerId: row.slug,
      slug: row.slug,
      // The protocol comes from the row's catalog `kind` (resolved by the
      // caller), NOT hardcoded — so an org Claude provider routes as anthropic,
      // an org OpenAI-compatible one as openai, etc. The protocol also decides
      // the auth header (Anthropic needs x-api-key, not Bearer).
      sdkCompat,
      apiKeyHeader: SDK_COMPAT_PROTOCOLS[sdkCompat].apiKeyHeader,
      upstreamBaseUrl: textUpstream,
      defaultModel: row.capabilities.text?.model,
      envVarName: orgProviderKeyEnvVarName(row.slug),
      providerDisplayName: row.displayName || row.slug,
      providerIconUrl: "",
      apiKeyInstructions: "",
      apiKeyPlaceholder: "",
      // Never surface synthetic org modules in the "Add Provider" catalog.
      catalogVisible: false,
      authProfilesManager: this.authProfilesManager,
    });

    // Make the slug routable on THIS pod's proxy. registerUpstream is
    // idempotent (map sets), and every replica reaches this path on demand from
    // the same row, so there is no cross-pod state to fan out.
    const upstream = module.getUpstreamConfig();
    if (upstream && this.registerUpstream) {
      this.registerUpstream(upstream, module.providerId);
    }
    return module;
  }

  /**
   * List all catalog-visible providers from the module registry.
   */
  listCatalogProviders(): ModelProviderModule[] {
    return getModelProviderModules().filter((m) => m.catalogVisible !== false);
  }

  /**
   * Resolve an agent's model policy: the routable provider modules PLUS the
   * exact-ref allow-list that gates which `<slug>/<model>` refs may run.
   *
   * A NON-empty `models` list is an EXACT allow-list (gate): only the exact
   * refs it names may run (`allowedRefs`), and only the providers those refs
   * (plus the org default's concrete ref, appended as the safety tail) name
   * are routed as modules. models[0] is the default; the remaining entries are
   * the agent's alternates — the ORDERED fallback candidates and the
   * per-channel (Listen) override pick-list.
   *
   * An EMPTY/absent list is allow-all (`allowedRefs = null`): every org
   * provider routes (default row first, remaining `inference_providers` rows in
   * listing order, then every deployment/system-key registry module), and any
   * ref whose provider is among them may run.
   *
   * Providers.json modules resolve directly. Any slug that isn't a
   * providers.json module is resolved (when `organizationId` is provided) from
   * the org's inference_providers rows: a matching row with a custom text
   * upstream is synthesized into a routable ApiKeyProviderModule. Slugs with no
   * matching custom-upstream row (or when no org is given) are dropped, as
   * before.
   */
  async getModelPolicy(
    agentId: string,
    organizationId?: string
  ): Promise<{
    modules: ModelProviderModule[];
    /** Ordered exact allow-list, or null when the agent allows all providers. */
    allowedRefs: string[] | null;
  }> {
    const policy = await resolveAgentModels(
      this.agentSettingsStore,
      agentId,
      organizationId
    );

    // NOT-FOUND ⇒ DENY-ALL: no agent row (or an orgless/cross-tenant refusal).
    // Return an EMPTY allow-list (distinct from `null` allow-all) with ZERO
    // modules, so any requested model fails closed. This is the fail-open bug
    // fix — a missing agent must never expose every org/system-key provider.
    if (policy.kind === "not-found") {
      return { modules: [], allowedRefs: [] };
    }

    const models = policy.kind === "restricted" ? policy.models : [];

    const allModules = getModelProviderModules();
    const moduleMap = new Map(allModules.map((m) => [m.providerId, m]));

    // Slugs not backed by a providers.json module may be org-defined inference
    // providers. Load the org's rows once and index by slug so each unmatched
    // slug — AND the org DEFAULT provider — can be synthesized.
    let orgRows: InferenceProviderListItem[] = [];
    let orgRowsBySlug: Map<string, InferenceProviderListItem> | undefined;
    let orgDefaultSlug: string | undefined;
    // Protocol per catalog slug, so a synthesized org row routes with the wire
    // protocol its `kind` declares (openai/anthropic/…), not a hardcoded one.
    let sdkCompatByKind: Map<string, SdkCompat> | undefined;
    if (organizationId && this.listOrgInferenceProviders) {
      orgRows = await this.listOrgInferenceProviders(organizationId);
      orgRowsBySlug = new Map(orgRows.map((r) => [r.slug, r]));
      orgDefaultSlug = orgRows.find((r) => r.isDefault)?.slug;
      sdkCompatByKind = new Map();
      for (const entry of buildProviderCatalog()) {
        if (isSdkCompat(entry.sdkCompat)) {
          sdkCompatByKind.set(entry.slug, entry.sdkCompat);
        }
      }
    }

    const providerIds: string[] = [];
    const seenSlug = new Set<string>();
    const pushSlug = (slug: string) => {
      if (slug && !seenSlug.has(slug)) {
        seenSlug.add(slug);
        providerIds.push(slug);
      }
    };

    // The exact allow-list (null = allow-all). Non-empty models list ⇒
    // allowedRefs is EXACTLY the listed refs — NO org-default safety tail.
    // An unroutable listed model FAILS CLOSED at dispatch; it never silently
    // escalates to an unlisted org-default model (that would widen the
    // restriction). A list of only `<slug>/__unresolved__` sentinels resolves
    // to zero routable modules → the run hard-fails closed (the intended
    // "restricted but nothing resolvable yet" state). The org default is only
    // consulted for the allow-ALL (empty/absent) case below.
    let allowedRefs: string[] | null = null;
    if (models.length > 0) {
      const refs: string[] = [];
      const seenRef = new Set<string>();
      const pushRef = (ref: string) => {
        if (ref && !seenRef.has(ref)) {
          seenRef.add(ref);
          refs.push(ref);
        }
      };
      for (const ref of models) {
        pushRef(ref);
        // A `<slug>/__unresolved__` sentinel keeps its place in the exact
        // allow-list (so a mixed list still knows it's a listed entry), but its
        // slug must NOT contribute a provider module — the sentinel is inert and
        // must never route. Skipping the slug here is what makes a sentinel-only
        // list resolve to ZERO modules → hard fail closed.
        if (isUnresolvedModelRef(ref)) continue;
        const slash = ref.indexOf("/");
        if (slash > 0) pushSlug(ref.slice(0, slash));
      }
      allowedRefs = refs;
    } else {
      // Empty/absent ⇒ ALL org providers: default row first, remaining org
      // rows, then every deployment/system-key registry module.
      if (orgDefaultSlug) pushSlug(orgDefaultSlug);
      for (const row of orgRows) pushSlug(row.slug);
      for (const module of allModules) {
        if (module.hasSystemKey()) pushSlug(module.providerId);
      }
    }

    const modules: ModelProviderModule[] = [];
    for (const providerId of providerIds) {
      const staticModule = moduleMap.get(providerId);
      if (staticModule) {
        modules.push(staticModule);
        continue;
      }
      const row = orgRowsBySlug?.get(providerId);
      if (row) {
        // Resolve the row's protocol from its catalog `kind`. Unknown/absent ⇒
        // default to openai (legacy rows created before kind carried a
        // protocol, and custom endpoints, are OpenAI-compatible).
        const sdkCompat = sdkCompatByKind?.get(row.kind) ?? "openai";
        const synthesized = this.synthesizeOrgProviderModule(row, sdkCompat);
        if (synthesized) modules.push(synthesized);
      }
    }
    return { modules, allowedRefs };
  }

  /**
   * Resolve an agent's routable provider modules (the module list only). Thin
   * wrapper over getModelPolicy for callers that don't need the allow-list.
   */
  async getInstalledModules(
    agentId: string,
    organizationId?: string
  ): Promise<ModelProviderModule[]> {
    return (await this.getModelPolicy(agentId, organizationId)).modules;
  }

  /**
   * The SINGLE, shared dispatch-model resolver used by BOTH the enqueue gate
   * (message-consumer) and session-context (gateway), so they always agree on
   * the effective model for a turn.
   *
   * Given a requested model, apply the exact allow-list; when the request is
   * disallowed or a sentinel, replace it with the first LISTED ref that is both
   * non-sentinel AND ROUTABLE (its provider module is present and keyed) — not
   * merely the first non-sentinel. Returns `{ model, modules, allowedRefs }`;
   * `model` is undefined when nothing routable qualifies (fail closed).
   */
  async resolveDispatchModel(
    agentId: string,
    organizationId: string | undefined,
    requestedModel: string | undefined,
    userId?: string
  ): Promise<{
    model: string | undefined;
    replaced: boolean;
    modules: ModelProviderModule[];
    allowedRefs: string[] | null;
  }> {
    const { modules, allowedRefs } = await this.getModelPolicy(
      agentId,
      organizationId
    );
    // A ref is routable when its (non-sentinel) provider module is present in
    // the policy's modules AND has a system key or stored credentials.
    const routableCache = new Map<string, boolean>();
    const isRoutable = (ref: string): boolean => {
      // Synchronous predicate for enforceModelAllowList: we precompute below.
      return routableCache.get(ref) ?? false;
    };
    // Precompute routability for each listed real ref (credential checks are
    // async, so we resolve them up front and feed the synchronous predicate).
    if (allowedRefs) {
      for (const ref of allowedRefs) {
        if (isUnresolvedModelRef(ref)) {
          routableCache.set(ref, false);
          continue;
        }
        const provider = await this.findProviderForModel(ref, modules);
        if (!provider) {
          routableCache.set(ref, false);
          continue;
        }
        const routable =
          provider.hasSystemKey() ||
          (await provider.hasCredentials(agentId, { organizationId, userId }));
        routableCache.set(ref, routable);
      }
    }
    const gate = enforceModelAllowList(requestedModel, allowedRefs, isRoutable);
    return { ...gate, modules, allowedRefs };
  }

  /**
   * Find the provider module whose model options include the given model string.
   */
  async findProviderForModel(
    model: string,
    providers?: ModelProviderModule[]
  ): Promise<ModelProviderModule | undefined> {
    // A restriction sentinel is never a real model — it must NOT resolve to a
    // credentialed provider by slug-prefix (that would route the sentinel as if
    // real, widening the restriction). Return undefined so the run fails closed.
    if (isUnresolvedModelRef(model)) return undefined;
    const candidates = providers || getModelProviderModules();
    for (const provider of candidates) {
      if (!provider.getModelOptions) continue;
      const options = await provider.getModelOptions("", "");
      if (options.some((opt) => opt.value === model)) {
        return provider;
      }
    }
    // Fallback: a "<providerId>/<model>" ref names its provider directly, so
    // match by the leading segment even when the provider's option list didn't
    // contain an exact value. This is essential for providers whose models are
    // fetched live and may be empty in this resolution context (e.g. Claude,
    // whose `getModelOptions` lists BARE ids like "claude-opus-4-8" while the
    // stored model is prefixed "claude/claude-opus-4-8"). Without it, a
    // claude/… model fails to match and falls through to the first credentialed
    // provider, mis-routing the request to the wrong upstream.
    const slashIndex = model.indexOf("/");
    if (slashIndex > 0) {
      const prefix = model.slice(0, slashIndex);
      const byProviderId = candidates.find((p) => p.providerId === prefix);
      if (byProviderId) {
        return byProviderId;
      }
    }
    return undefined;
  }
}
