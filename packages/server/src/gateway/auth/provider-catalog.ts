import {
  createLogger,
  type InstalledProvider,
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
import type { DeclaredAgentRegistry } from "../services/declared-agent-registry.js";
import { ApiKeyProviderModule } from "./api-key-provider-module.js";
import type { AgentSettingsStore } from "./settings/agent-settings-store.js";
import type { AuthProfilesManager } from "./settings/auth-profiles-manager.js";
import { reconcileModelSelectionForInstalledProviders } from "./settings/model-selection.js";

const logger = createLogger("provider-catalog");

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
 * Resolve an agent's installed providers.
 */
async function resolveInstalledProviders(
  agentSettingsStore: AgentSettingsStore,
  agentId: string
): Promise<InstalledProvider[]> {
  const settings = await agentSettingsStore.getSettings(agentId);
  return settings?.installedProviders || [];
}

/**
 * ProviderCatalogService wraps the module registry to provide
 * per-agent provider install/uninstall/reorder operations.
 *
 * Providers are registered globally in the module registry,
 * but each agent chooses which providers to install from the catalog.
 */
const DECLARED_AGENT_MUTATION_ERROR =
  "provider list is declared in lobu.config.ts; edit the file and restart";

export class ProviderCatalogService {
  constructor(
    private agentSettingsStore: AgentSettingsStore,
    private authProfilesManager: AuthProfilesManager,
    private declaredAgents: DeclaredAgentRegistry,
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

  private guardDeclared(agentId: string): void {
    if (this.declaredAgents.has(agentId)) {
      throw new Error(DECLARED_AGENT_MUTATION_ERROR);
    }
  }

  /**
   * List all catalog-visible providers from the module registry.
   */
  listCatalogProviders(): ModelProviderModule[] {
    return getModelProviderModules().filter((m) => m.catalogVisible !== false);
  }

  /**
   * Resolve an agent's installedProviders to their module instances.
   * Returns modules in the agent's install order.
   *
   * Providers.json modules resolve directly. Any installed slug that isn't a
   * providers.json module is resolved (when `organizationId` is provided) from
   * the org's inference_providers rows: a matching row with a custom text
   * upstream is synthesized into a routable ApiKeyProviderModule. Slugs with no
   * matching custom-upstream row (or when no org is given) are dropped, as
   * before.
   */
  async getInstalledModules(
    agentId: string,
    organizationId?: string
  ): Promise<ModelProviderModule[]> {
    const installed = await resolveInstalledProviders(
      this.agentSettingsStore,
      agentId
    );
    if (installed.length === 0) return [];

    const allModules = getModelProviderModules();
    const moduleMap = new Map(allModules.map((m) => [m.providerId, m]));

    // Slugs not backed by a providers.json module may be org-defined inference
    // providers. Load the org's rows once and index by slug so each unmatched
    // installed slug can be synthesized in install order.
    let orgRowsBySlug: Map<string, InferenceProviderListItem> | undefined;
    // Protocol per catalog slug, so a synthesized org row routes with the wire
    // protocol its `kind` declares (openai/anthropic/…), not a hardcoded one.
    let sdkCompatByKind: Map<string, SdkCompat> | undefined;
    if (
      organizationId &&
      this.listOrgInferenceProviders &&
      installed.some((ip) => !moduleMap.has(ip.providerId))
    ) {
      const rows = await this.listOrgInferenceProviders(organizationId);
      orgRowsBySlug = new Map(rows.map((r) => [r.slug, r]));
      sdkCompatByKind = new Map();
      for (const entry of buildProviderCatalog()) {
        if (isSdkCompat(entry.sdkCompat)) {
          sdkCompatByKind.set(entry.slug, entry.sdkCompat);
        }
      }
    }

    const resolved: ModelProviderModule[] = [];
    for (const ip of installed) {
      const staticModule = moduleMap.get(ip.providerId);
      if (staticModule) {
        resolved.push(staticModule);
        continue;
      }
      const row = orgRowsBySlug?.get(ip.providerId);
      if (row) {
        // Resolve the row's protocol from its catalog `kind`. Unknown/absent ⇒
        // default to openai (legacy rows created before kind carried a
        // protocol, and custom endpoints, are OpenAI-compatible).
        const sdkCompat = sdkCompatByKind?.get(row.kind) ?? "openai";
        const synthesized = this.synthesizeOrgProviderModule(row, sdkCompat);
        if (synthesized) resolved.push(synthesized);
      }
    }
    return resolved;
  }

  /**
   * Get raw installed provider entries for an agent.
   */
  async getInstalledProviders(agentId: string): Promise<InstalledProvider[]> {
    return resolveInstalledProviders(this.agentSettingsStore, agentId);
  }

  /**
   * Install a provider for an agent. Appends to the end of the list.
   */
  async installProvider(agentId: string, providerId: string): Promise<void> {
    this.guardDeclared(agentId);
    const allModules = getModelProviderModules();
    const module = allModules.find((m) => m.providerId === providerId);
    if (!module) {
      throw new Error(`Unknown provider: ${providerId}`);
    }

    const settings = await this.agentSettingsStore.getSettings(agentId);
    const installed = settings?.installedProviders || [];

    if (installed.some((ip) => ip.providerId === providerId)) {
      logger.info(
        `Provider ${providerId} already installed for agent ${agentId}`
      );
      return;
    }

    const entry: InstalledProvider = {
      providerId,
      installedAt: Date.now(),
    };
    const nextInstalledProviders = [...installed, entry];
    const reconciled = reconcileModelSelectionForInstalledProviders({
      model: settings?.model,
      modelSelection: settings?.modelSelection,
      providerModelPreferences: settings?.providerModelPreferences,
      installedProviders: nextInstalledProviders,
    });

    await this.agentSettingsStore.updateSettings(agentId, {
      installedProviders: nextInstalledProviders,
      ...reconciled,
    });

    logger.info(`Installed provider ${providerId} for agent ${agentId}`);
  }

  /**
   * Uninstall a provider from an agent. Also cleans up auth profiles.
   */
  async uninstallProvider(agentId: string, providerId: string): Promise<void> {
    this.guardDeclared(agentId);
    const settings = await this.agentSettingsStore.getSettings(agentId);
    const installed = settings?.installedProviders || [];

    const filtered = installed.filter((ip) => ip.providerId !== providerId);
    if (filtered.length === installed.length) {
      logger.info(
        `Provider ${providerId} not installed for agent ${agentId}, nothing to uninstall`
      );
      return;
    }

    // Clean up ephemeral auth profiles. User-scoped profiles in
    // UserAuthProfileStore stay put — uninstalling a provider on a
    // runtime agent shouldn't cascade-delete every user's tokens; users
    // remove their own credentials from the per-user UI.
    await this.authProfilesManager.deleteProviderProfiles(agentId, providerId);
    const reconciled = reconcileModelSelectionForInstalledProviders({
      model: settings?.model,
      modelSelection: settings?.modelSelection,
      providerModelPreferences: settings?.providerModelPreferences,
      installedProviders: filtered,
    });

    await this.agentSettingsStore.updateSettings(agentId, {
      installedProviders: filtered,
      ...reconciled,
    });

    logger.info(`Uninstalled provider ${providerId} for agent ${agentId}`);
  }

  /**
   * Find the provider module whose model options include the given model string.
   */
  async findProviderForModel(
    model: string,
    providers?: ModelProviderModule[]
  ): Promise<ModelProviderModule | undefined> {
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

  /**
   * Reorder installed providers. The orderedIds must contain
   * exactly the same provider IDs as currently installed.
   */
  async reorderProviders(agentId: string, orderedIds: string[]): Promise<void> {
    this.guardDeclared(agentId);
    const settings = await this.agentSettingsStore.getSettings(agentId);
    const installed = settings?.installedProviders || [];

    const installedMap = new Map(installed.map((ip) => [ip.providerId, ip]));

    // Validate all ordered IDs exist in installed
    for (const id of orderedIds) {
      if (!installedMap.has(id)) {
        throw new Error(`Provider ${id} is not installed`);
      }
    }

    const reordered = orderedIds
      .map((id) => installedMap.get(id))
      .filter((ip): ip is InstalledProvider => ip !== undefined);

    // Append any installed providers not in orderedIds (shouldn't happen but safety)
    for (const ip of installed) {
      if (!orderedIds.includes(ip.providerId)) {
        reordered.push(ip);
      }
    }
    const reconciled = reconcileModelSelectionForInstalledProviders({
      model: settings?.model,
      modelSelection: settings?.modelSelection,
      providerModelPreferences: settings?.providerModelPreferences,
      installedProviders: reordered,
    });

    await this.agentSettingsStore.updateSettings(agentId, {
      installedProviders: reordered,
      ...reconciled,
    });

    logger.info(
      `Reordered providers for agent ${agentId}: ${orderedIds.join(", ")}`
    );
  }
}
