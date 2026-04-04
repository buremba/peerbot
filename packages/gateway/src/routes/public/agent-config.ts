/**
 * Agent Config Routes
 *
 * Configuration endpoints mounted under /api/v1/agents/{agentId}/config
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AgentConfigStore, AuthProfile, SkillConfig } from "@lobu/core";
import type { ProviderCatalogService } from "../../auth/provider-catalog";
import { collectProviderModelOptions } from "../../auth/provider-model-options";

import type { AgentSettings, AgentSettingsStore } from "../../auth/settings";
import type { AuthProfilesManager } from "../../auth/settings/auth-profiles-manager";
import { getModelSelectionState } from "../../auth/settings/model-selection";
import {
  canEditSettingsSection,
  type ResolvedProviderView,
  type ResolvedSectionView,
  SETTINGS_SECTION_KEYS,
  type SettingsSectionKey,
} from "../../auth/settings/resolved-settings-view";
import type { SettingsTokenPayload } from "../../auth/settings/token-service";
import type { UserAgentsStore } from "../../auth/user-agents-store";
import type { WorkerConnectionManager } from "../../gateway/connection-manager";
import type { IMessageQueue } from "../../infrastructure/queue";
import {
  getModelProviderModules,
  type ModelOption,
  type ModelProviderModule,
} from "../../modules/module-system";
import type { ScheduledWakeupService } from "../../orchestration/scheduled-wakeup";
import type { GrantStore } from "../../permissions/grant-store";
import { createTokenVerifier } from "../shared/token-verifier";
import { verifySettingsSessionOrToken } from "./settings-auth";

const TAG = "Configuration";
const ErrorResponse = z.object({ error: z.string() });
const TokenQuery = z.object({ token: z.string().optional() });
const REDACTED_VALUE = "__LOBU_REDACTED__";

export interface ConfigChangeEntry {
  category:
    | "mcp"
    | "provider"
    | "model"
    | "packages"
    | "skills"
    | "instructions"
    | "env"
    | "plugins"
    | "logging";
  action: "added" | "removed" | "updated" | "reordered";
  summary: string;
  details?: string[];
}
const SENSITIVE_KEY_PATTERN =
  /(?:credential|secret|token|password|api(?:_|-)?key|authorization)/i;

type SanitizedAuthProfile = Omit<AuthProfile, "credential" | "metadata"> & {
  credential: string;
  credentialRedacted: true;
  metadata?: Omit<NonNullable<AuthProfile["metadata"]>, "refreshToken"> & {
    refreshToken?: string;
    refreshTokenRedacted?: true;
  };
};

type PublicAgentSettings = Omit<AgentSettings, "authProfiles"> & {
  authProfiles?: SanitizedAuthProfile[];
};

// --- Route Definitions ---

const getConfigRoute = createRoute({
  method: "get",
  path: "/",
  tags: [TAG],
  summary: "Get agent configuration",
  request: { query: TokenQuery },
  responses: {
    200: {
      description: "Configuration",
      content: {
        "application/json": {
          schema: z.any(),
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

export interface ProviderCredentialStore {
  hasCredentials(agentId: string): Promise<boolean>;
}

export interface AgentConfigRoutesConfig {
  agentSettingsStore: AgentSettingsStore;
  agentConfigStore: Pick<AgentConfigStore, "getMetadata" | "getSettings">;
  userAgentsStore?: UserAgentsStore;
  providerStores?: Record<string, ProviderCredentialStore>;
  /**
   * Provider connectivity overrides (e.g., system token means "connected" even if no user credentials are stored).
   */
  providerConnectedOverrides?: Record<string, boolean>;
  providerCatalogService?: ProviderCatalogService;
  authProfilesManager?: AuthProfilesManager;
  queue?: IMessageQueue;
  connectionManager?: WorkerConnectionManager;
  grantStore?: GrantStore;
  scheduledWakeupService?: ScheduledWakeupService;
}

function getViewer(payload: SettingsTokenPayload | null | undefined): {
  settingsMode?: "admin" | "user";
  allowedScopes?: string[];
  isAdmin?: boolean;
} {
  return {
    settingsMode: payload?.settingsMode,
    allowedScopes: payload?.allowedScopes,
    isAdmin: payload?.isAdmin,
  };
}

function getProviderModelPreferencesFromSettings(
  settings: AgentSettings | null | undefined
): Record<string, string> {
  const directPreferences = Object.fromEntries(
    Object.entries(settings?.providerModelPreferences || {})
      .map(([providerId, modelRef]) => [providerId.trim(), modelRef.trim()])
      .filter(([providerId, modelRef]) => providerId && modelRef)
  );
  if (Object.keys(directPreferences).length > 0) {
    return directPreferences;
  }

  const fallbackPreferences: Record<string, string> = {};
  for (const ip of settings?.installedProviders || []) {
    if (ip.config?.modelPreference) {
      fallbackPreferences[ip.providerId] = String(ip.config.modelPreference);
    }
  }
  return fallbackPreferences;
}

function hasOwnSetting(
  settings: AgentSettings | null | undefined,
  key: keyof AgentSettings
): boolean {
  return !!settings && Object.hasOwn(settings, key);
}

const SECTION_SETTING_KEYS: Record<
  Exclude<SettingsSectionKey, "permissions" | "schedules">,
  Array<keyof AgentSettings>
> = {
  model: [
    "installedProviders",
    "authProfiles",
    "model",
    "modelSelection",
    "providerModelPreferences",
  ],
  "system-prompt": ["identityMd", "soulMd", "userMd"],
  skills: ["skillsConfig", "mcpServers", "pluginsConfig"],
  packages: ["nixConfig"],
  logging: ["verboseLogging"],
};

function sectionHasLocalOverride(
  section: SettingsSectionKey,
  localSettings: AgentSettings | null | undefined
): boolean {
  if (section === "permissions" || section === "schedules") {
    return false;
  }
  return SECTION_SETTING_KEYS[section].some((key) =>
    hasOwnSetting(localSettings, key)
  );
}

function sectionHasTemplateValue(
  section: SettingsSectionKey,
  templateSettings: AgentSettings | null | undefined
): boolean {
  if (section === "permissions" || section === "schedules") {
    return false;
  }
  return SECTION_SETTING_KEYS[section].some((key) =>
    hasOwnSetting(templateSettings, key)
  );
}

function resolveSectionSource(
  isSandbox: boolean,
  hasLocalOverride: boolean,
  hasTemplateValue: boolean
): "local" | "inherited" | "mixed" {
  if (!isSandbox) return "local";
  if (!hasLocalOverride && hasTemplateValue) return "inherited";
  if (hasLocalOverride && hasTemplateValue) return "mixed";
  return "local";
}

function resolveProviderSources(
  localSettings: AgentSettings | null,
  effectiveSettings: AgentSettings | null,
  templateSettings: AgentSettings | null,
  isSandbox: boolean,
  viewer: ReturnType<typeof getViewer>
): Record<string, ResolvedProviderView> {
  const effectiveProviderIds = (
    effectiveSettings?.installedProviders || []
  ).map((provider) => provider.providerId);
  const localProviderIds = new Set(
    (localSettings?.installedProviders || []).map(
      (provider) => provider.providerId
    )
  );
  const localProfileProviders = new Set(
    (localSettings?.authProfiles || []).map((profile) => profile.provider)
  );
  const localPreferenceProviders = new Set(
    Object.keys(localSettings?.providerModelPreferences || {})
  );
  const templateProviderIds = new Set(
    (templateSettings?.installedProviders || []).map(
      (provider) => provider.providerId
    )
  );

  return Object.fromEntries(
    effectiveProviderIds.map((providerId) => {
      const hasLocalOverride =
        localProviderIds.has(providerId) ||
        localProfileProviders.has(providerId) ||
        localPreferenceProviders.has(providerId);

      const source = resolveSectionSource(
        isSandbox,
        hasLocalOverride,
        templateProviderIds.has(providerId)
      );

      return [
        providerId,
        {
          id: providerId,
          source,
          canEdit: canEditSettingsSection("model", viewer),
          canReset: isSandbox && hasLocalOverride,
          hasLocalOverride,
        } satisfies ResolvedProviderView,
      ];
    })
  );
}

async function resolveSettingsView(
  config: AgentConfigRoutesConfig,
  agentId: string,
  payload: SettingsTokenPayload | null
): Promise<{
  scope: "agent" | "sandbox";
  templateAgentId?: string;
  templateAgentName?: string;
  sections: Record<SettingsSectionKey, ResolvedSectionView>;
  providerSources: Record<string, ResolvedProviderView>;
  effectiveSettings: AgentSettings | null;
}> {
  const viewer = getViewer(payload);
  const localSettings = await config.agentSettingsStore.getSettings(agentId);
  const effectiveSettings =
    await config.agentSettingsStore.getEffectiveSettings(agentId);
  const templateAgentId =
    effectiveSettings?.templateAgentId || localSettings?.templateAgentId;
  const templateSettings = templateAgentId
    ? await config.agentSettingsStore.getSettings(templateAgentId)
    : null;
  const templateAgentName = templateAgentId
    ? (await config.agentConfigStore.getMetadata(templateAgentId))?.name
    : undefined;
  const isSandbox = !!templateAgentId;

  const sections = Object.fromEntries(
    SETTINGS_SECTION_KEYS.map((section) => {
      const hasLocalOverride = sectionHasLocalOverride(section, localSettings);
      const hasTemplateValue = sectionHasTemplateValue(
        section,
        templateSettings
      );

      return [
        section,
        {
          source: resolveSectionSource(
            isSandbox,
            hasLocalOverride,
            hasTemplateValue
          ),
          editable: canEditSettingsSection(section, viewer),
          canReset: isSandbox && hasLocalOverride,
          hasLocalOverride,
        } satisfies ResolvedSectionView,
      ];
    })
  ) as Record<SettingsSectionKey, ResolvedSectionView>;

  return {
    scope: isSandbox ? "sandbox" : "agent",
    templateAgentId,
    templateAgentName,
    sections,
    providerSources: resolveProviderSources(
      localSettings,
      effectiveSettings,
      templateSettings,
      isSandbox,
      viewer
    ),
    effectiveSettings,
  };
}

async function buildResolvedConfigResponse(
  config: AgentConfigRoutesConfig,
  agentId: string,
  payload: SettingsTokenPayload | null,
  providerModels: Record<string, ModelOption[]>
): Promise<any> {
  const [settingsView, grants, schedules] = await Promise.all([
    resolveSettingsView(config, agentId, payload),
    config.grantStore?.listGrants(agentId) ?? Promise.resolve([]),
    config.scheduledWakeupService?.listPendingForAgent(agentId) ??
      Promise.resolve([]),
  ]);
  const settings = settingsView.effectiveSettings;

  const providers: Record<
    string,
    {
      connected: boolean;
      userConnected: boolean;
      systemConnected: boolean;
      activeAuthType?: string;
      authMethods?: string[];
    }
  > = {};
  if (config.providerStores) {
    for (const [name, store] of Object.entries(config.providerStores)) {
      try {
        const hasSystemCredentials =
          config.providerConnectedOverrides?.[name] === true;
        const hasUserCredentials = await store.hasCredentials(agentId);

        const profiles = config.authProfilesManager
          ? await config.authProfilesManager.getProviderProfiles(agentId, name)
          : [];
        const now = Date.now();
        const validProfiles = profiles.filter(
          (profile) =>
            !profile.metadata?.expiresAt || profile.metadata.expiresAt > now
        );

        providers[name] = {
          connected: hasUserCredentials || hasSystemCredentials,
          userConnected: hasUserCredentials,
          systemConnected: hasSystemCredentials,
          activeAuthType: validProfiles[0]?.authType,
          authMethods: validProfiles.map((profile) => profile.authType),
        };
      } catch {
        providers[name] = {
          connected: false,
          userConnected: false,
          systemConnected: false,
        };
      }
    }
  }

  const allModules = getModelProviderModules();
  const allProviderMeta = allModules
    .filter((module) => module.catalogVisible !== false)
    .map((module: ModelProviderModule) => ({
      id: module.providerId,
      name: module.providerDisplayName,
      iconUrl: module.providerIconUrl || "",
      authType: (module.authType || "oauth") as
        | "oauth"
        | "device-code"
        | "api-key",
      supportedAuthTypes: (module.supportedAuthTypes as (
        | "oauth"
        | "device-code"
        | "api-key"
      )[]) || [
        (module.authType || "oauth") as "oauth" | "device-code" | "api-key",
      ],
      apiKeyInstructions: module.apiKeyInstructions || "",
      apiKeyPlaceholder: module.apiKeyPlaceholder || "",
      capabilities: [] as string[],
    }));

  const installedIds = (settings?.installedProviders || []).map(
    (provider) => provider.providerId
  );
  const installedIdSet = new Set(installedIds);
  const catalogProviders = allProviderMeta.filter(
    (provider) => !installedIdSet.has(provider.id)
  );
  const providerIconUrls: Record<string, string> = {};
  for (const provider of allProviderMeta) {
    if (provider.iconUrl) {
      providerIconUrls[provider.id] = provider.iconUrl;
    }
  }

  const providerMeta: Record<string, object> = {};
  for (const provider of allProviderMeta) {
    providerMeta[provider.id] = {
      name: provider.name,
      authType: provider.authType,
      supportedAuthTypes: provider.supportedAuthTypes,
      apiKeyInstructions: provider.apiKeyInstructions,
      apiKeyPlaceholder: provider.apiKeyPlaceholder,
      capabilities: provider.capabilities,
    };
  }

  const sanitized = sanitizeSettingsForResponse(settings);
  return {
    agentId,
    scope: settingsView.scope,
    templateAgentId: settingsView.templateAgentId,
    templateAgentName: settingsView.templateAgentName,
    sections: settingsView.sections,
    providerViews: settingsView.providerSources,
    instructions: {
      identity: sanitized.identityMd || "",
      soul: sanitized.soulMd || "",
      user: sanitized.userMd || "",
    },
    providers: {
      order: installedIds,
      status: providers,
      catalog: catalogProviders,
      meta: providerMeta,
      models: providerModels,
      preferences: getProviderModelPreferencesFromSettings(settings),
      icons: providerIconUrls,
      modelSelection: getModelSelectionState(settings || undefined),
      configManaged: [] as string[],
    },
    skills: sanitized.skillsConfig?.skills || [],
    mcpServers: sanitized.mcpServers || {},
    tools: {
      nixPackages: sanitized.nixConfig?.packages || [],
      permissions: grants,
      schedules: schedules.map((schedule) => ({
        scheduleId: schedule.id,
        task: schedule.task,
        scheduledFor: schedule.triggerAt,
        status: schedule.status,
        isRecurring: schedule.isRecurring,
        cron: schedule.cron,
        iteration: schedule.iteration,
        maxIterations: schedule.maxIterations,
      })),
      registries: [],
      globalRegistries: [],
    },
    settings: {
      verboseLogging: !!sanitized.verboseLogging,
      memoryEnabled: !!process.env.MEMORY_URL,
    },
  };
}

export function createAgentConfigRoutes(
  config: AgentConfigRoutesConfig
): OpenAPIHono {
  const app = new OpenAPIHono();

  const baseVerifyToken = createTokenVerifier({
    userAgentsStore: config.userAgentsStore,
    agentMetadataStore: config.agentConfigStore,
  });

  /**
   * Verify settings token against agentId.
   * Admin sessions bypass ownership checks.
   * Owner-scoped browser sessions get admin-equivalent access for their own
   * agents, while exact agent-scoped tokens remain limited unless they were
   * explicitly minted as admin/user-mode sessions.
   */
  const verifyToken = async (
    payload: SettingsTokenPayload | null,
    agentId: string
  ): Promise<SettingsTokenPayload | null> => {
    if (!payload) return null;
    if (payload.isAdmin || payload.settingsMode === "admin") {
      return {
        ...payload,
        isAdmin: true,
        settingsMode: "admin",
      };
    }

    const verified = await baseVerifyToken(payload, agentId);
    if (!verified) return null;

    if (verified.agentId || verified.settingsMode === "user") {
      return verified;
    }

    return {
      ...verified,
      isAdmin: true,
      settingsMode: "admin",
    };
  };

  app.openapi(getConfigRoute, async (c): Promise<any> => {
    const agentId = c.req.param("agentId") || "";
    const payload = await verifyToken(verifySettingsSessionOrToken(c), agentId);
    if (!payload) return c.json({ error: "Unauthorized" }, 401);
    const providerModels = await collectProviderModelOptions(
      agentId,
      payload.userId
    );
    return c.json(
      await buildResolvedConfigResponse(
        config,
        agentId,
        payload,
        providerModels
      )
    );
  });

  // --- Provider Catalog Endpoints ---

  // GET /providers/catalog
  app.get("/providers/catalog", async (c): Promise<any> => {
    const agentId = c.req.param("agentId") || "";
    const payload = await verifyToken(verifySettingsSessionOrToken(c), agentId);
    if (!payload) return c.json({ error: "Unauthorized" }, 401);

    if (!config.providerCatalogService) {
      return c.json({ error: "Provider catalog not available" }, 503);
    }

    const allProviders = config.providerCatalogService.listCatalogProviders();
    const effectiveSettings =
      await config.agentSettingsStore.getEffectiveSettings(agentId);
    const installed = effectiveSettings?.installedProviders || [];
    const installedIds = new Set(installed.map((ip) => ip.providerId));

    const catalog = allProviders.map((p) => ({
      providerId: p.providerId,
      name: p.providerDisplayName,
      iconUrl: p.providerIconUrl || "",
      authType: p.authType || "api-key",
      description: p.catalogDescription || "",
      installed: installedIds.has(p.providerId),
    }));

    return c.json({ catalog, installedProviders: installed });
  });

  // ===== Grant Endpoints (read-only) =====

  if (config.grantStore) {
    const grantStore = config.grantStore;

    // GET /grants - List all active grants
    app.get("/grants", async (c) => {
      const agentId = c.req.param("agentId") || "";
      const payload = await verifyToken(
        verifySettingsSessionOrToken(c),
        agentId
      );
      if (!payload) return c.json({ error: "Unauthorized" }, 401);

      const grants = await grantStore.listGrants(agentId);
      return c.json(grants);
    });
  }

  return app;
}

function sanitizeSettingsForResponse(
  settings: AgentSettings | null
): PublicAgentSettings | Record<string, never> {
  if (!settings) return {};

  const sanitized = redactSensitiveFields(settings) as PublicAgentSettings;

  if (sanitized.skillsConfig?.skills) {
    sanitized.skillsConfig = {
      skills: sanitized.skillsConfig.skills.map((skill) => {
        const legacySkill = skill as SkillConfig & {
          integrations?: unknown;
        };
        const {
          integrations: _integrations,
          modelPreference: _modelPreference,
          thinkingLevel: _thinkingLevel,
          ...rest
        } = legacySkill;
        return rest;
      }),
    };
  }

  if (Array.isArray(settings.authProfiles)) {
    sanitized.authProfiles = settings.authProfiles.map(sanitizeAuthProfile);
  }

  return sanitized;
}

function sanitizeAuthProfile(profile: AuthProfile): SanitizedAuthProfile {
  const hadRefreshToken = !!profile.metadata?.refreshToken;
  const metadata = profile.metadata
    ? (redactSensitiveFields(
        profile.metadata
      ) as SanitizedAuthProfile["metadata"])
    : undefined;

  if (metadata && hadRefreshToken) {
    metadata.refreshTokenRedacted = true;
  }

  return {
    ...profile,
    credential: REDACTED_VALUE,
    credentialRedacted: true,
    metadata,
  };
}

function redactSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveFields(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  for (const [key, rawValue] of Object.entries(input)) {
    if (
      typeof rawValue === "string" &&
      rawValue.length > 0 &&
      SENSITIVE_KEY_PATTERN.test(key)
    ) {
      output[key] = REDACTED_VALUE;
      continue;
    }

    output[key] = redactSensitiveFields(rawValue);
  }

  return output;
}
