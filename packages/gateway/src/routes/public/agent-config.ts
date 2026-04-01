/**
 * Agent Config Routes
 *
 * Configuration endpoints mounted under /api/v1/agents/{agentId}/config
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { type AuthProfile, createLogger, type SkillConfig } from "@lobu/core";
import type { AgentMetadataStore } from "../../auth/agent-metadata-store";
import type { ProviderCatalogService } from "../../auth/provider-catalog";
import { collectProviderModelOptions } from "../../auth/provider-model-options";

import type { AgentSettings, AgentSettingsStore } from "../../auth/settings";
import type { AuthProfilesManager } from "../../auth/settings/auth-profiles-manager";
import {
  extractProviderIdFromModelRef,
  getModelSelectionState,
  type ProviderModelPreferences,
  reconcileModelSelectionForInstalledProviders,
} from "../../auth/settings/model-selection";
import {
  resolveSettingsView,
  type SettingsSectionKey,
} from "../../auth/settings/resolved-settings-view";
import { buildPromotedSettingsFromSource } from "../../auth/settings/template-utils";
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
import { verifySettingsSession } from "./settings-auth";

const TAG = "Configuration";
const ErrorResponse = z.object({ error: z.string() });
const TokenQuery = z.object({ token: z.string().optional() });
const logger = createLogger("agent-config-routes");
const REDACTED_VALUE = "__LOBU_REDACTED__";

function hasOwnKey(value: object, key: keyof AgentSettings | string): boolean {
  return Object.hasOwn(value, key);
}

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

const updateConfigRoute = createRoute({
  method: "patch",
  path: "/",
  tags: [TAG],
  summary: "Update agent configuration",
  request: {
    query: TokenQuery,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            model: z.string().optional(),
            modelSelection: z
              .object({
                mode: z.enum(["auto", "pinned"]),
                pinnedModel: z.string().optional(),
              })
              .optional(),
            providerModelPreferences: z
              .record(z.string(), z.string())
              .optional(),
            soulMd: z.string().optional(),
            userMd: z.string().optional(),
            identityMd: z.string().optional(),
            nixConfig: z
              .object({
                flakeUrl: z.string().optional(),
                packages: z.array(z.string()).optional(),
              })
              .nullable()
              .optional(),
            mcpServers: z.record(z.string(), z.any()).optional(),
            skillsConfig: z
              .object({
                skills: z.array(
                  z.object({
                    repo: z.string(),
                    name: z.string(),
                    description: z.string(),
                    enabled: z.boolean(),
                    content: z.string().optional(),
                    contentFetchedAt: z.number().optional(),
                  })
                ),
              })
              .optional(),
            pluginsConfig: z
              .object({
                plugins: z.array(
                  z.object({
                    source: z.string(),
                    slot: z.enum(["tool", "provider", "memory"]),
                    enabled: z.boolean().optional(),
                    config: z.record(z.string(), z.any()).optional(),
                  })
                ),
              })
              .optional(),
            skillRegistries: z
              .array(
                z.object({
                  id: z.string(),
                  type: z.string(),
                  apiUrl: z.string(),
                })
              )
              .nullable()
              .optional(),
            verboseLogging: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated",
      content: {
        "application/json": {
          schema: z.object({ success: z.boolean(), agentId: z.string() }),
        },
      },
    },
    400: {
      description: "Invalid",
      content: { "application/json": { schema: ErrorResponse } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

const promoteSandboxRoute = createRoute({
  method: "post",
  path: "/promote",
  tags: [TAG],
  summary: "Promote sandbox configuration back to its template agent",
  request: { query: TokenQuery },
  responses: {
    200: {
      description: "Promoted",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            sourceAgentId: z.string(),
            targetAgentId: z.string(),
          }),
        },
      },
    },
    400: {
      description: "Invalid",
      content: { "application/json": { schema: ErrorResponse } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponse } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

const resetSectionRoute = createRoute({
  method: "post",
  path: "/reset-section",
  tags: [TAG],
  summary: "Reset a sandbox section to inherit from its base agent",
  request: {
    query: TokenQuery,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            section: z.enum([
              "model",
              "system-prompt",
              "skills",
              "packages",
              "permissions",
              "schedules",
              "logging",
            ]),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Reset",
      content: {
        "application/json": {
          schema: z.object({ success: z.boolean(), agentId: z.string() }),
        },
      },
    },
    400: {
      description: "Invalid",
      content: { "application/json": { schema: ErrorResponse } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponse } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

export interface ProviderCredentialStore {
  hasCredentials(agentId: string): Promise<boolean>;
}

interface NixPackageSuggestion {
  name: string;
  pname?: string;
  description?: string;
}

interface NixSearchContext {
  username: string;
  password: string;
  alias: string;
  expiresAt: number;
}

let nixSearchContextCache: NixSearchContext | null = null;

export interface AgentConfigRoutesConfig {
  agentSettingsStore: AgentSettingsStore;
  userAgentsStore?: UserAgentsStore;
  agentMetadataStore?: AgentMetadataStore;
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

async function syncPromotedGrants(
  grantStore: GrantStore,
  sourceAgentId: string,
  targetAgentId: string
): Promise<void> {
  const sourceGrants = await grantStore.listGrants(sourceAgentId);
  const targetGrants = await grantStore.listGrants(targetAgentId);

  const sourceByPattern = new Map(
    sourceGrants.map((grant) => [grant.pattern, grant])
  );
  const targetByPattern = new Map(
    targetGrants.map((grant) => [grant.pattern, grant])
  );

  for (const [pattern] of targetByPattern) {
    if (!sourceByPattern.has(pattern)) {
      await grantStore.revoke(targetAgentId, pattern);
    }
  }

  for (const [pattern, grant] of sourceByPattern) {
    const existing = targetByPattern.get(pattern);
    if (
      !existing ||
      existing.expiresAt !== grant.expiresAt ||
      !!existing.denied !== !!grant.denied
    ) {
      if (existing) {
        await grantStore.revoke(targetAgentId, pattern);
      }
      await grantStore.grant(
        targetAgentId,
        pattern,
        grant.expiresAt,
        grant.denied
      );
    }
  }
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

async function buildResolvedConfigResponse(
  config: AgentConfigRoutesConfig,
  agentId: string,
  payload: SettingsTokenPayload | null,
  providerModels: Record<string, ModelOption[]>
): Promise<any> {
  const [settingsView, grants, schedules] = await Promise.all([
    resolveSettingsView({
      agentId,
      agentSettingsStore: config.agentSettingsStore,
      agentMetadataStore: config.agentMetadataStore,
      viewer: getViewer(payload),
    }),
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
      registries: sanitized.skillRegistries || [],
      globalRegistries: [] as any[],
    },
    settings: {
      verboseLogging: !!sanitized.verboseLogging,
      memoryEnabled: !!process.env.AUTH_MCP_URL,
    },
  };
}

function resetUpdatesForSection(
  section: SettingsSectionKey
): Partial<Omit<AgentSettings, "updatedAt">> {
  switch (section) {
    case "model":
      return {
        installedProviders: undefined,
        authProfiles: undefined,
        model: undefined,
        modelSelection: undefined,
        providerModelPreferences: undefined,
      };
    case "system-prompt":
      return {
        identityMd: undefined,
        soulMd: undefined,
        userMd: undefined,
      };
    case "skills":
      return {
        skillsConfig: undefined,
        mcpServers: undefined,
        skillRegistries: undefined,
        pluginsConfig: undefined,
      };
    case "packages":
      return { nixConfig: undefined };
    case "logging":
      return { verboseLogging: undefined };
    case "permissions":
    case "schedules":
      return {};
  }
}

function buildConfigChanges(
  existing: AgentSettings | null,
  updates: Partial<AgentSettings>
): ConfigChangeEntry[] {
  const changes: ConfigChangeEntry[] = [];

  // MCP servers
  if (updates.mcpServers !== undefined) {
    const oldIds = new Set(Object.keys(existing?.mcpServers || {}));
    const newIds = new Set(Object.keys(updates.mcpServers || {}));
    for (const id of newIds) {
      if (!oldIds.has(id)) {
        changes.push({
          category: "mcp",
          action: "added",
          summary: `MCP server "${id}" installed`,
        });
      }
    }
    for (const id of oldIds) {
      if (!newIds.has(id)) {
        changes.push({
          category: "mcp",
          action: "removed",
          summary: `MCP server "${id}" removed`,
        });
      }
    }
    // Check for updates on existing servers
    for (const id of newIds) {
      if (oldIds.has(id)) {
        const oldCfg = JSON.stringify(existing?.mcpServers?.[id] || {});
        const newCfg = JSON.stringify(updates.mcpServers?.[id] || {});
        if (oldCfg !== newCfg) {
          changes.push({
            category: "mcp",
            action: "updated",
            summary: `MCP server "${id}" updated`,
          });
        }
      }
    }
  }

  // Nix packages
  if (updates.nixConfig !== undefined) {
    const oldPkgs = existing?.nixConfig?.packages || [];
    const newPkgs = updates.nixConfig?.packages || [];
    const added = newPkgs.filter((p) => !oldPkgs.includes(p));
    const removed = oldPkgs.filter((p) => !newPkgs.includes(p));
    if (added.length > 0 || removed.length > 0) {
      const details: string[] = [];
      if (added.length > 0) details.push(`Added: ${added.join(", ")}`);
      if (removed.length > 0) details.push(`Removed: ${removed.join(", ")}`);
      changes.push({
        category: "packages",
        action: added.length > 0 ? "updated" : "removed",
        summary: "System packages updated",
        details,
      });
    }
  }

  // Model
  const includesModelUpdate = hasOwnKey(updates, "model");
  const includesModelSelectionUpdate = hasOwnKey(updates, "modelSelection");
  const includesProviderModelPreferencesUpdate = hasOwnKey(
    updates,
    "providerModelPreferences"
  );
  if (
    includesModelUpdate ||
    includesModelSelectionUpdate ||
    includesProviderModelPreferencesUpdate
  ) {
    const previousSelection = getModelSelectionState(existing);
    const nextSelection = getModelSelectionState({
      model: includesModelUpdate ? updates.model : existing?.model,
      modelSelection: includesModelSelectionUpdate
        ? updates.modelSelection
        : existing?.modelSelection,
    });

    const normalizePrefs = (
      preferences: ProviderModelPreferences | undefined
    ): ProviderModelPreferences =>
      Object.fromEntries(
        Object.entries(preferences || {}).sort(([a], [b]) => a.localeCompare(b))
      );

    const previousPrefs = normalizePrefs(existing?.providerModelPreferences);
    const nextPrefs = normalizePrefs(
      includesProviderModelPreferencesUpdate
        ? updates.providerModelPreferences
        : existing?.providerModelPreferences
    );

    if (
      JSON.stringify(previousSelection) !== JSON.stringify(nextSelection) ||
      JSON.stringify(previousPrefs) !== JSON.stringify(nextPrefs)
    ) {
      changes.push({
        category: "model",
        action: "updated",
        summary:
          nextSelection.mode === "pinned" && nextSelection.pinnedModel
            ? `Model pinned to "${nextSelection.pinnedModel}"`
            : Object.keys(nextPrefs).length > 0
              ? "Auto model preferences updated"
              : "Model selection set to auto",
      });
    }
  }

  // Skills
  if (updates.skillsConfig !== undefined) {
    const oldSkills = (existing?.skillsConfig?.skills || []).filter(
      (s) => s.enabled
    );
    const newSkills = (updates.skillsConfig?.skills || []).filter(
      (s) => s.enabled
    );
    const oldNames = new Set(oldSkills.map((s) => s.name));
    const newNames = new Set(newSkills.map((s) => s.name));
    const added = [...newNames].filter((n) => !oldNames.has(n));
    const removed = [...oldNames].filter((n) => !newNames.has(n));
    if (added.length > 0 || removed.length > 0) {
      const details: string[] = [];
      if (added.length > 0) details.push(`Enabled: ${added.join(", ")}`);
      if (removed.length > 0) details.push(`Disabled: ${removed.join(", ")}`);
      changes.push({
        category: "skills",
        action: "updated",
        summary: "Skills configuration updated",
        details,
      });
    }
  }

  // Instructions (soulMd, userMd, identityMd)
  if (
    (updates.soulMd !== undefined && updates.soulMd !== existing?.soulMd) ||
    (updates.userMd !== undefined && updates.userMd !== existing?.userMd) ||
    (updates.identityMd !== undefined &&
      updates.identityMd !== existing?.identityMd)
  ) {
    changes.push({
      category: "instructions",
      action: "updated",
      summary: "Agent instructions updated",
    });
  }

  // Plugins
  if (updates.pluginsConfig !== undefined) {
    changes.push({
      category: "plugins",
      action: "updated",
      summary: "Plugins configuration updated",
    });
  }

  // Verbose logging
  if (
    updates.verboseLogging !== undefined &&
    updates.verboseLogging !== existing?.verboseLogging
  ) {
    changes.push({
      category: "logging",
      action: "updated",
      summary: `Verbose logging ${updates.verboseLogging ? "enabled" : "disabled"}`,
    });
  }

  return changes;
}

export function createAgentConfigRoutes(
  config: AgentConfigRoutesConfig
): OpenAPIHono {
  const app = new OpenAPIHono();

  const baseVerifyToken = createTokenVerifier(config);

  /**
   * Verify settings token against agentId.
   * Admin sessions bypass ownership checks.
   */
  const verifyToken = async (
    payload: SettingsTokenPayload | null,
    agentId: string
  ): Promise<SettingsTokenPayload | null> => {
    if (!payload) return null;
    if (payload.isAdmin) return payload;
    return baseVerifyToken(payload, agentId);
  };

  app.openapi(getConfigRoute, async (c): Promise<any> => {
    const agentId = c.req.param("agentId") || "";
    const payload = await verifyToken(verifySettingsSession(c), agentId);
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

  app.openapi(updateConfigRoute, async (c): Promise<any> => {
    const agentId = c.req.param("agentId") || "";
    const payload = await verifyToken(verifySettingsSession(c), agentId);
    if (!payload) return c.json({ error: "Unauthorized" }, 401);

    try {
      const settingsView = await resolveSettingsView({
        agentId,
        agentSettingsStore: config.agentSettingsStore,
        agentMetadataStore: config.agentMetadataStore,
        viewer: getViewer(payload),
      });
      const existingSettings = settingsView.localSettings;
      const effectiveSettings = settingsView.effectiveSettings;
      const providerModelOptions = await collectProviderModelOptions(
        agentId,
        payload.userId
      );
      const availableModels = new Set<string>();
      for (const options of Object.values(providerModelOptions)) {
        for (const option of options) {
          availableModels.add(option.value);
        }
      }
      const body = restoreRedactedSentinels(
        c.req.valid("json"),
        existingSettings || {}
      );

      // Scope enforcement: strip fields not in allowed scopes for "user" mode
      if (payload.settingsMode === "user" && payload.allowedScopes?.length) {
        const allowed = new Set(payload.allowedScopes);
        // model scope controls: model, modelSelection, providerModelPreferences
        if (!allowed.has("model")) {
          delete body.model;
          delete body.modelSelection;
          delete body.providerModelPreferences;
        }
        // system-prompt scope controls: soulMd, userMd, identityMd
        if (!allowed.has("system-prompt")) {
          delete body.soulMd;
          delete body.userMd;
          delete body.identityMd;
        }
        // mcp-servers scope controls: mcpServers
        if (!allowed.has("mcp-servers")) {
          delete body.mcpServers;
        }
        // tools scope controls: skillsConfig, pluginsConfig, nixConfig
        if (!allowed.has("tools")) {
          delete body.skillsConfig;
          delete body.pluginsConfig;
          delete body.nixConfig;
          delete body.skillRegistries;
        }
      }

      const updates: Partial<AgentSettings> = {};

      // Handle explicit null for nixConfig (clear)
      if (body.nixConfig === null) {
        updates.nixConfig = undefined;
        delete body.nixConfig;
      }
      if (body.skillRegistries === null) {
        updates.skillRegistries = [];
        delete body.skillRegistries;
      }

      if (Object.keys(body).length > 0) {
        const validated = await validateSettings(
          body as Partial<AgentSettings>,
          {
            availableModels,
            providerModelOptions,
            installedProviderIds: new Set(
              (effectiveSettings?.installedProviders || []).map(
                (provider) => provider.providerId
              )
            ),
          }
        );
        Object.assign(updates, validated);
      }

      if (
        hasOwnKey(body, "model") ||
        hasOwnKey(body, "modelSelection") ||
        hasOwnKey(body, "providerModelPreferences")
      ) {
        const reconciled = reconcileModelSelectionForInstalledProviders({
          model: hasOwnKey(updates, "model")
            ? updates.model
            : existingSettings?.model,
          modelSelection: hasOwnKey(updates, "modelSelection")
            ? updates.modelSelection
            : (existingSettings?.modelSelection ??
              effectiveSettings?.modelSelection),
          providerModelPreferences: hasOwnKey(
            updates,
            "providerModelPreferences"
          )
            ? updates.providerModelPreferences
            : (existingSettings?.providerModelPreferences ??
              effectiveSettings?.providerModelPreferences),
          installedProviders: effectiveSettings?.installedProviders || [],
        });
        Object.assign(updates, reconciled);
      }

      if (Object.keys(updates).length > 0) {
        const changes = buildConfigChanges(existingSettings, updates);
        await config.agentSettingsStore.updateSettings(agentId, updates);

        // Notify active workers of config changes
        config.connectionManager?.notifyAgent(agentId, "config_changed", {
          changes,
        });
      }

      if (updates.skillsConfig) {
        await cleanupOrphanedSkillDependencies(
          config.agentSettingsStore,
          agentId,
          existingSettings?.skillsConfig?.skills || [],
          updates.skillsConfig.skills || []
        );
      }

      if (body.mcpServers && config.queue && payload.sourceContext) {
        await maybeSendMcpInstalledNotifications({
          queue: config.queue,
          agentSettingsStore: config.agentSettingsStore,
          agentId,
          userId: payload.userId,
          platform: payload.sourceContext.platform || payload.platform,
          channelId: payload.sourceContext.channelId,
          conversationId: payload.sourceContext.conversationId,
          teamId: payload.sourceContext.teamId,
          previousSettings: existingSettings,
          nextMcpServers: updates.mcpServers || existingSettings?.mcpServers,
        });
      }

      return c.json({ success: true, agentId });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Invalid" }, 400);
    }
  });

  app.openapi(promoteSandboxRoute, async (c): Promise<any> => {
    const sourceAgentId = c.req.param("agentId") || "";
    const payload = await verifyToken(verifySettingsSession(c), sourceAgentId);
    if (!payload) return c.json({ error: "Unauthorized" }, 401);
    if (!payload.isAdmin) {
      return c.json({ error: "Admin access required" }, 403);
    }

    const sourceSettings =
      await config.agentSettingsStore.getSettings(sourceAgentId);
    const targetAgentId = sourceSettings?.templateAgentId?.trim();
    if (!targetAgentId) {
      return c.json(
        { error: "Sandbox is not linked to a template agent" },
        400
      );
    }

    const sourceMetadata = config.agentMetadataStore
      ? await config.agentMetadataStore.getMetadata(sourceAgentId)
      : null;
    if (config.agentMetadataStore && !sourceMetadata?.parentConnectionId) {
      return c.json({ error: "Only sandbox agents can be promoted" }, 400);
    }

    const targetMetadata = config.agentMetadataStore
      ? await config.agentMetadataStore.getMetadata(targetAgentId)
      : null;
    if (
      sourceMetadata?.owner &&
      targetMetadata?.owner &&
      (sourceMetadata.owner.platform !== targetMetadata.owner.platform ||
        sourceMetadata.owner.userId !== targetMetadata.owner.userId)
    ) {
      return c.json(
        { error: "Sandbox target does not match the owning agent" },
        403
      );
    }

    const targetSettings =
      await config.agentSettingsStore.getSettings(targetAgentId);
    const promotedSettings = buildPromotedSettingsFromSource(sourceSettings);
    const changes = buildConfigChanges(targetSettings, promotedSettings);

    await config.agentSettingsStore.updateSettings(
      targetAgentId,
      promotedSettings
    );

    await cleanupOrphanedSkillDependencies(
      config.agentSettingsStore,
      targetAgentId,
      targetSettings?.skillsConfig?.skills || [],
      sourceSettings?.skillsConfig?.skills || []
    );

    if (config.grantStore) {
      await syncPromotedGrants(config.grantStore, sourceAgentId, targetAgentId);
    }

    if (changes.length > 0) {
      config.connectionManager?.notifyAgent(targetAgentId, "config_changed", {
        changes,
      });
    }

    return c.json({
      success: true,
      sourceAgentId,
      targetAgentId,
    });
  });

  app.openapi(resetSectionRoute, async (c): Promise<any> => {
    const agentId = c.req.param("agentId") || "";
    const payload = await verifyToken(verifySettingsSession(c), agentId);
    if (!payload) return c.json({ error: "Unauthorized" }, 401);

    const { section } = c.req.valid("json");
    const settingsView = await resolveSettingsView({
      agentId,
      agentSettingsStore: config.agentSettingsStore,
      agentMetadataStore: config.agentMetadataStore,
      viewer: getViewer(payload),
    });

    if (!settingsView.isSandbox || !settingsView.templateAgentId) {
      return c.json(
        { error: "Only sandbox agents can reset inherited sections" },
        400
      );
    }

    if (!settingsView.sections[section].editable) {
      return c.json({ error: "Scope not allowed" }, 403);
    }

    try {
      if (section === "permissions" && config.grantStore) {
        const grants = await config.grantStore.listGrants(agentId);
        await Promise.all(
          grants.map((grant) =>
            config.grantStore!.revoke(agentId, grant.pattern)
          )
        );
      }

      if (section === "schedules" && config.scheduledWakeupService) {
        const schedules =
          await config.scheduledWakeupService.listPendingForAgent(agentId);
        await Promise.all(
          schedules.map((schedule) =>
            config.scheduledWakeupService!.cancelByAgent(schedule.id, agentId)
          )
        );
      }

      const updates = resetUpdatesForSection(section);
      if (Object.keys(updates).length > 0) {
        await config.agentSettingsStore.updateSettings(agentId, updates);
      }

      config.connectionManager?.notifyAgent(agentId, "config_changed", {
        changes: [
          {
            category:
              section === "system-prompt"
                ? "instructions"
                : section === "skills"
                  ? "skills"
                  : section === "packages"
                    ? "packages"
                    : section === "logging"
                      ? "logging"
                      : "model",
            action: "updated",
            summary: `Reset ${section} section to inherit from the base agent`,
          },
        ] satisfies ConfigChangeEntry[],
      });

      return c.json({ success: true, agentId });
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error ? error.message : "Failed to reset section",
        },
        400
      );
    }
  });

  // GET /packages/search?q=python
  app.get("/packages/search", async (c): Promise<any> => {
    const agentId = c.req.param("agentId") || "";
    const payload = await verifyToken(verifySettingsSession(c), agentId);
    if (!payload) return c.json({ error: "Unauthorized" }, 401);

    const query = (c.req.query("q") || "").trim();
    if (query.length < 2) return c.json({ packages: [] });

    try {
      const packages = await searchNixPackages(query);
      return c.json({ packages });
    } catch (error) {
      logger.warn("Nix package search failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ packages: [] });
    }
  });

  // --- Provider Catalog Endpoints ---

  // GET /providers/catalog
  app.get("/providers/catalog", async (c): Promise<any> => {
    const agentId = c.req.param("agentId") || "";
    const payload = await verifyToken(verifySettingsSession(c), agentId);
    if (!payload) return c.json({ error: "Unauthorized" }, 401);

    if (!config.providerCatalogService) {
      return c.json({ error: "Provider catalog not available" }, 503);
    }

    const allProviders = config.providerCatalogService.listCatalogProviders();
    const installed =
      await config.providerCatalogService.getInstalledProviders(agentId);
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

  // PUT /providers/:providerId - Install (enabled: true) or uninstall (enabled: false) a provider
  app.put("/providers/:providerId", async (c): Promise<any> => {
    const agentId = c.req.param("agentId") || "";
    const providerId = c.req.param("providerId") || "";
    const payload = await verifyToken(verifySettingsSession(c), agentId);
    if (!payload) return c.json({ error: "Unauthorized" }, 401);

    // Scope enforcement: providers require "model" scope
    if (
      payload.settingsMode === "user" &&
      payload.allowedScopes?.length &&
      !payload.allowedScopes.includes("model")
    ) {
      return c.json({ error: "Scope not allowed" }, 403);
    }

    if (!config.providerCatalogService) {
      return c.json({ error: "Provider catalog not available" }, 503);
    }

    if (!providerId) {
      return c.json({ error: "providerId is required" }, 400);
    }

    try {
      const body = await c.req.json();
      const { enabled, config: providerConfig } = body;

      if (enabled === false) {
        await config.providerCatalogService.uninstallProvider(
          agentId,
          providerId.trim()
        );
        config.connectionManager?.notifyAgent(agentId, "config_changed", {
          changes: [
            {
              category: "provider",
              action: "removed",
              summary: `Provider "${providerId.trim()}" removed`,
            },
          ] satisfies ConfigChangeEntry[],
        });
      } else {
        await config.providerCatalogService.installProvider(
          agentId,
          providerId.trim(),
          providerConfig
        );
        config.connectionManager?.notifyAgent(agentId, "config_changed", {
          changes: [
            {
              category: "provider",
              action: "added",
              summary: `Provider "${providerId.trim()}" installed`,
            },
          ] satisfies ConfigChangeEntry[],
        });
      }

      return c.json({ success: true, agentId });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "Operation failed" },
        400
      );
    }
  });

  // PATCH /providers/reorder
  app.patch("/providers/reorder", async (c): Promise<any> => {
    const agentId = c.req.param("agentId") || "";
    const payload = await verifyToken(verifySettingsSession(c), agentId);
    if (!payload) return c.json({ error: "Unauthorized" }, 401);

    // Scope enforcement: provider reorder requires "model" scope
    if (
      payload.settingsMode === "user" &&
      payload.allowedScopes?.length &&
      !payload.allowedScopes.includes("model")
    ) {
      return c.json({ error: "Scope not allowed" }, 403);
    }

    if (!config.providerCatalogService) {
      return c.json({ error: "Provider catalog not available" }, 503);
    }

    try {
      const body = await c.req.json();
      const { providerIds } = body;
      if (!Array.isArray(providerIds)) {
        return c.json({ error: "providerIds array is required" }, 400);
      }

      const orderedIds = providerIds.filter(
        (id): id is string => typeof id === "string"
      );
      await config.providerCatalogService.reorderProviders(agentId, orderedIds);
      config.connectionManager?.notifyAgent(agentId, "config_changed", {
        changes: [
          {
            category: "provider",
            action: "reordered",
            summary: `Provider priority: ${orderedIds.join(" > ")}`,
          },
        ] satisfies ConfigChangeEntry[],
      });
      return c.json({ success: true, agentId });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "Reorder failed" },
        400
      );
    }
  });

  // ===== Grant Endpoints =====

  if (config.grantStore) {
    const grantStore = config.grantStore;

    // GET /grants - List all active grants
    app.get("/grants", async (c) => {
      const agentId = c.req.param("agentId") || "";
      const payload = await verifyToken(verifySettingsSession(c), agentId);
      if (!payload) return c.json({ error: "Unauthorized" }, 401);

      const grants = await grantStore.listGrants(agentId);
      return c.json(grants);
    });

    // POST /grants - Create a grant
    app.post("/grants", async (c) => {
      const agentId = c.req.param("agentId") || "";
      const payload = await verifyToken(verifySettingsSession(c), agentId);
      if (!payload) return c.json({ error: "Unauthorized" }, 401);

      const body = await c.req.json<{
        pattern: string;
        expiresAt: number | null;
        denied?: boolean;
      }>();
      if (!body.pattern) {
        return c.json({ error: "pattern is required" }, 400);
      }

      await grantStore.grant(
        agentId,
        body.pattern,
        body.expiresAt ?? null,
        body.denied
      );
      logger.info("Grant created via settings API", {
        agentId,
        pattern: body.pattern,
        expiresAt: body.expiresAt,
      });
      return c.json({ success: true });
    });

    // DELETE /grants/:pattern - Revoke a grant
    app.delete("/grants/:pattern", async (c) => {
      const agentId = c.req.param("agentId") || "";
      const pattern = decodeURIComponent(c.req.param("pattern") || "");
      const payload = await verifyToken(verifySettingsSession(c), agentId);
      if (!payload) return c.json({ error: "Unauthorized" }, 401);

      await grantStore.revoke(agentId, pattern);
      logger.info("Grant revoked via settings API", { agentId, pattern });
      return c.json({ success: true });
    });
  }

  return app;
}

async function resolveNixSearchContext(): Promise<NixSearchContext> {
  if (nixSearchContextCache && nixSearchContextCache.expiresAt > Date.now()) {
    return nixSearchContextCache;
  }

  const bundleResp = await fetch("https://search.nixos.org/bundle.js");
  if (!bundleResp.ok) {
    throw new Error(`Failed to fetch Nix search bundle: ${bundleResp.status}`);
  }
  const bundleText = await bundleResp.text();

  const userMatch = bundleText.match(/elasticsearchUsername:"([^"]+)"/);
  const passMatch = bundleText.match(/elasticsearchPassword:"([^"]+)"/);
  const versionMatch = bundleText.match(
    /elasticsearchMappingSchemaVersion:parseInt\("(\d+)"\)/
  );
  const channelsMatch = bundleText.match(
    /nixosChannels:JSON\.parse\('([^']+)'\)/
  );

  if (!userMatch?.[1] || !passMatch?.[1]) {
    throw new Error("Unable to parse Nix search credentials");
  }

  let preferredAlias: string | undefined;
  if (versionMatch?.[1] && channelsMatch?.[1]) {
    try {
      const channelsData = JSON.parse(channelsMatch[1]) as {
        default?: string;
        channels?: Array<{ id?: string }>;
      };
      const unstableChannel = channelsData.channels?.find(
        (channel) => channel.id === "unstable"
      )?.id;
      const channelId = unstableChannel || channelsData.default || "unstable";
      preferredAlias = `latest-${versionMatch[1]}-nixos-${channelId}`;
    } catch {
      preferredAlias = undefined;
    }
  }

  const authHeader = `Basic ${Buffer.from(
    `${userMatch[1]}:${passMatch[1]}`
  ).toString("base64")}`;
  const aliasesResp = await fetch(
    "https://search.nixos.org/backend/_cat/aliases?h=alias",
    {
      headers: {
        Authorization: authHeader,
      },
    }
  );

  let alias = preferredAlias;
  if (aliasesResp.ok) {
    const aliasesText = await aliasesResp.text();
    const aliases = aliasesText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    alias =
      aliases.find((value) => /^latest-\d+-nixos-unstable$/.test(value)) ||
      alias ||
      aliases.find((value) => /^latest-\d+-nixos-[\w.-]+$/.test(value));
  }

  if (!alias) {
    throw new Error("Unable to resolve Nix search alias");
  }

  nixSearchContextCache = {
    username: userMatch[1],
    password: passMatch[1],
    alias,
    expiresAt: Date.now() + 10 * 60 * 1000,
  };

  return nixSearchContextCache;
}

async function searchNixPackages(
  query: string
): Promise<NixPackageSuggestion[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  const runSearch = async (context: NixSearchContext) => {
    const authHeader = `Basic ${Buffer.from(
      `${context.username}:${context.password}`
    ).toString("base64")}`;

    const searchResp = await fetch(
      `https://search.nixos.org/backend/${encodeURIComponent(context.alias)}/_search`,
      {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          size: 10,
          _source: [
            "package_attr_name",
            "package_pname",
            "package_description",
          ],
          query: {
            multi_match: {
              query: trimmedQuery,
              fields: [
                "package_attr_name^4",
                "package_pname^3",
                "package_description",
              ],
            },
          },
        }),
      }
    );

    if (!searchResp.ok) {
      throw new Error(`Nix search failed: ${searchResp.status}`);
    }

    const data = (await searchResp.json()) as {
      hits?: {
        hits?: Array<{
          _source?: {
            package_attr_name?: string;
            package_pname?: string;
            package_description?: string;
          };
        }>;
      };
    };

    const seen = new Set<string>();
    const results: NixPackageSuggestion[] = [];
    for (const hit of data.hits?.hits || []) {
      const source = hit._source;
      const name = source?.package_attr_name?.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      results.push({
        name,
        pname: source?.package_pname || undefined,
        description: source?.package_description || undefined,
      });
    }

    return results;
  };

  let context = await resolveNixSearchContext();
  try {
    return await runSearch(context);
  } catch {
    // Retry once with fresh context in case alias changed.
    nixSearchContextCache = null;
    context = await resolveNixSearchContext();
    return runSearch(context);
  }
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

function restoreRedactedSentinels<T>(input: T, previous: unknown): T {
  if (input === REDACTED_VALUE && typeof previous === "string") {
    return previous as T;
  }

  if (Array.isArray(input)) {
    const previousEntries = Array.isArray(previous) ? previous : [];
    const restored = input.map((entry, index) =>
      restoreRedactedSentinels(entry, previousEntries[index])
    );
    return restored as T;
  }

  if (!input || typeof input !== "object") {
    return input;
  }

  const inputObject = input as Record<string, unknown>;
  const previousObject =
    previous && typeof previous === "object"
      ? (previous as Record<string, unknown>)
      : {};
  const restored: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(inputObject)) {
    restored[key] = restoreRedactedSentinels(value, previousObject[key]);
  }

  return restored as T;
}

// --- Validation ---

async function validateSettings(
  input: Partial<AgentSettings>,
  modelValidation: {
    availableModels: Set<string>;
    providerModelOptions: Record<string, ModelOption[]>;
    installedProviderIds: Set<string>;
  }
): Promise<Omit<AgentSettings, "updatedAt">> {
  const settings: Omit<AgentSettings, "updatedAt"> = {};

  const inferProviderIdForModelRef = (modelRef: string): string | undefined => {
    const providerIds = Object.entries(modelValidation.providerModelOptions)
      .filter(([, options]) =>
        options.some((option) => option.value === modelRef)
      )
      .map(([providerId]) => providerId);

    if (providerIds.length === 1) return providerIds[0];
    return undefined;
  };

  const resolveProviderIdForModelRef = (modelRef: string): string | undefined =>
    extractProviderIdFromModelRef(modelRef) ||
    inferProviderIdForModelRef(modelRef);

  const validateKnownModelRef = (modelRef: string): void => {
    if (modelValidation.availableModels.size === 0) {
      throw new Error(
        "No models are currently available from configured providers."
      );
    }
    if (!modelValidation.availableModels.has(modelRef)) {
      throw new Error(`Invalid model: ${modelRef}`);
    }
  };

  if (typeof input.soulMd === "string") {
    settings.soulMd = input.soulMd;
  }
  if (typeof input.userMd === "string") {
    settings.userMd = input.userMd;
  }
  if (typeof input.identityMd === "string") {
    settings.identityMd = input.identityMd;
  }

  if (typeof input.model === "string") {
    const cleanModel = input.model.trim();
    if (!cleanModel) {
      settings.model = undefined;
      settings.modelSelection = { mode: "auto" };
    } else {
      validateKnownModelRef(cleanModel);
      settings.model = cleanModel;
      settings.modelSelection = { mode: "pinned", pinnedModel: cleanModel };
    }
  }

  if (input.modelSelection && typeof input.modelSelection === "object") {
    const mode = input.modelSelection.mode;
    const pinnedModel = input.modelSelection.pinnedModel?.trim();

    if (mode === "auto") {
      settings.modelSelection = { mode: "auto" };
      settings.model = undefined;
    } else {
      if (!pinnedModel) {
        throw new Error("Pinned model is required when mode is pinned");
      }
      validateKnownModelRef(pinnedModel);
      const pinnedProviderId = resolveProviderIdForModelRef(pinnedModel);
      if (!pinnedProviderId) {
        throw new Error(
          `Unable to resolve provider for pinned model: ${pinnedModel}`
        );
      }
      if (!modelValidation.installedProviderIds.has(pinnedProviderId)) {
        throw new Error(
          `Pinned model provider "${pinnedProviderId}" is not installed`
        );
      }
      settings.modelSelection = { mode: "pinned", pinnedModel };
      settings.model = pinnedModel;
    }
  }

  if (
    input.providerModelPreferences &&
    typeof input.providerModelPreferences === "object"
  ) {
    const preferences: ProviderModelPreferences = {};

    for (const [providerIdRaw, modelRefRaw] of Object.entries(
      input.providerModelPreferences
    )) {
      const providerId = providerIdRaw.trim();
      const modelRef = modelRefRaw.trim();
      if (!providerId || !modelRef) continue;

      if (!modelValidation.installedProviderIds.has(providerId)) {
        throw new Error(
          `Model preference set for non-installed provider: ${providerId}`
        );
      }

      const modelProviderId = resolveProviderIdForModelRef(modelRef);
      if (modelProviderId && modelProviderId !== providerId) {
        throw new Error(
          `Model "${modelRef}" belongs to provider "${modelProviderId}", not "${providerId}"`
        );
      }

      const providerOptions =
        modelValidation.providerModelOptions[providerId] || [];
      if (
        providerOptions.length > 0 &&
        !providerOptions.some((option) => option.value === modelRef)
      ) {
        throw new Error(
          `Invalid model for provider "${providerId}": ${modelRef}`
        );
      }

      preferences[providerId] = modelRef;
    }

    settings.providerModelPreferences =
      Object.keys(preferences).length > 0 ? preferences : undefined;
  }

  if (input.nixConfig) {
    const flakeUrl = input.nixConfig.flakeUrl?.trim();
    const packages = input.nixConfig.packages
      ?.filter((pkg): pkg is string => typeof pkg === "string" && !!pkg.trim())
      .map((pkg) => pkg.trim());

    if (!flakeUrl && (!packages || packages.length === 0)) {
      throw new Error(
        "nixConfig requires flakeUrl or at least one package when set"
      );
    }

    settings.nixConfig = {
      flakeUrl: flakeUrl || undefined,
      packages: packages?.length ? packages : undefined,
    };
  }

  if (input.mcpServers && typeof input.mcpServers === "object") {
    settings.mcpServers = {};
    for (const [id, config] of Object.entries(input.mcpServers)) {
      // Validate MCP ID format (alphanumeric, dash, underscore, starting with letter)
      const cleanId = id.trim();
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(cleanId)) {
        throw new Error(`Invalid MCP ID: ${cleanId}`);
      }

      // Skip if config is not an object
      if (typeof config !== "object" || config === null) continue;

      const mcpConfig: Record<string, unknown> = {};
      const cfg = config as Record<string, unknown>;

      // Validate URL for HTTP MCPs
      if (typeof cfg.url === "string") {
        const url = cfg.url.trim();
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          throw new Error(
            `Invalid MCP URL for ${cleanId}: must be http:// or https://`
          );
        }
        mcpConfig.url = url;
      }

      // Handle command-based MCPs
      if (typeof cfg.command === "string") {
        mcpConfig.command = cfg.command;
        if (Array.isArray(cfg.args)) {
          mcpConfig.args = cfg.args.filter((a) => typeof a === "string");
        }
      }

      // Optional fields
      if (typeof cfg.description === "string") {
        mcpConfig.description = cfg.description;
      }
      if (typeof cfg.enabled === "boolean") {
        mcpConfig.enabled = cfg.enabled;
      }

      // Copy through any other config fields (oauth, headers, etc.)
      for (const [key, value] of Object.entries(cfg)) {
        if (
          !["url", "command", "args", "description", "enabled"].includes(key)
        ) {
          mcpConfig[key] = value;
        }
      }

      settings.mcpServers[cleanId] = mcpConfig;
    }
  }

  if (input.skillsConfig) {
    settings.skillsConfig = {
      skills: input.skillsConfig.skills.map((skill) => ({
        repo: skill.repo,
        name: skill.name,
        description: skill.description,
        enabled: skill.enabled,
        content: skill.content,
        contentFetchedAt: skill.contentFetchedAt,
      })),
    };
  }

  if (Array.isArray(input.skillRegistries)) {
    settings.skillRegistries = input.skillRegistries
      .filter(
        (
          entry
        ): entry is NonNullable<AgentSettings["skillRegistries"]>[number] =>
          !!entry &&
          typeof entry.id === "string" &&
          typeof entry.type === "string" &&
          typeof entry.apiUrl === "string"
      )
      .map((entry) => ({
        id: entry.id.trim(),
        type: entry.type.trim(),
        apiUrl: entry.apiUrl.trim(),
      }))
      .filter((entry) => entry.id && entry.type && entry.apiUrl);
  }

  if (input.pluginsConfig) {
    settings.pluginsConfig = {
      plugins: input.pluginsConfig.plugins
        .filter((p) => typeof p.source === "string" && p.source.trim())
        .map((p) => ({
          source: p.source.trim(),
          slot: p.slot,
          enabled: p.enabled ?? true,
          config:
            p.config && typeof p.config === "object"
              ? { ...p.config }
              : undefined,
        })),
    };
  }

  if (typeof input.verboseLogging === "boolean") {
    settings.verboseLogging = input.verboseLogging;
  }

  return settings;
}

/**
 * Compute what dependencies are no longer needed after skills change.
 * Returns sets of IDs to remove.
 */
function computeSkillDependencyDiff(
  oldSkills: SkillConfig[],
  newSkills: SkillConfig[]
): {
  removedMcpServers: string[];
  removedNixPackages: string[];
  removedPermissions: string[];
} {
  const activeMcpServers = new Set<string>();
  const activeNixPackages = new Set<string>();
  const activePermissions = new Set<string>();

  for (const skill of newSkills) {
    if (!skill.enabled) continue;
    if (skill.mcpServers) {
      for (const mcp of skill.mcpServers) activeMcpServers.add(mcp.id);
    }
    if (skill.nixPackages) {
      for (const pkg of skill.nixPackages) activeNixPackages.add(pkg);
    }
    if (skill.permissions) {
      for (const perm of skill.permissions) activePermissions.add(perm);
    }
  }

  const previousMcpServers = new Set<string>();
  const previousNixPackages = new Set<string>();
  const previousPermissions = new Set<string>();

  for (const skill of oldSkills) {
    if (!skill.enabled) continue;
    if (skill.mcpServers) {
      for (const mcp of skill.mcpServers) previousMcpServers.add(mcp.id);
    }
    if (skill.nixPackages) {
      for (const pkg of skill.nixPackages) previousNixPackages.add(pkg);
    }
    if (skill.permissions) {
      for (const perm of skill.permissions) previousPermissions.add(perm);
    }
  }

  return {
    removedMcpServers: [...previousMcpServers].filter(
      (id) => !activeMcpServers.has(id)
    ),
    removedNixPackages: [...previousNixPackages].filter(
      (pkg) => !activeNixPackages.has(pkg)
    ),
    removedPermissions: [...previousPermissions].filter(
      (perm) => !activePermissions.has(perm)
    ),
  };
}

/**
 * Cleanup orphaned dependencies when skills are removed or disabled.
 * Only removes dependencies that were exclusively owned by removed skills.
 */
async function cleanupOrphanedSkillDependencies(
  agentSettingsStore: AgentSettingsStore,
  agentId: string,
  oldSkills: SkillConfig[],
  newSkills: SkillConfig[]
): Promise<void> {
  const diff = computeSkillDependencyDiff(oldSkills, newSkills);

  const hasRemovals =
    diff.removedMcpServers.length > 0 || diff.removedNixPackages.length > 0;

  if (!hasRemovals) return;

  const settings = await agentSettingsStore.getSettings(agentId);
  if (!settings) return;

  const updates: Record<string, unknown> = {};

  // Remove orphaned MCP servers
  if (diff.removedMcpServers.length > 0 && settings.mcpServers) {
    const cleaned = { ...settings.mcpServers };
    for (const id of diff.removedMcpServers) {
      delete cleaned[id];
    }
    updates.mcpServers = cleaned;
  }

  // Remove orphaned nix packages
  if (diff.removedNixPackages.length > 0 && settings.nixConfig?.packages) {
    const removedSet = new Set(diff.removedNixPackages);
    const remaining = settings.nixConfig.packages.filter(
      (p) => !removedSet.has(p)
    );
    updates.nixConfig = {
      ...settings.nixConfig,
      packages: remaining.length > 0 ? remaining : undefined,
    };
  }

  if (Object.keys(updates).length > 0) {
    await agentSettingsStore.updateSettings(agentId, updates);
    logger.info("Cleaned up orphaned skill dependencies", {
      agentId,
      removedMcpServers: diff.removedMcpServers,
      removedNixPackages: diff.removedNixPackages,
    });
  }
}

function getEnabledHttpMcpIds(
  mcpServers: AgentSettings["mcpServers"] | undefined
): Set<string> {
  const ids = new Set<string>();
  for (const [id, config] of Object.entries(mcpServers || {})) {
    if (!config || typeof config !== "object") continue;
    const cfg = config as Record<string, unknown>;
    if (cfg.enabled === false) continue;
    if (typeof cfg.url !== "string") continue;
    const url = cfg.url.trim();
    if (!url.startsWith("http://") && !url.startsWith("https://")) continue;
    ids.add(id);
  }
  return ids;
}

async function maybeSendMcpInstalledNotifications(options: {
  queue: IMessageQueue;
  agentSettingsStore: AgentSettingsStore;
  agentId: string;
  userId: string;
  platform: string;
  channelId: string;
  conversationId: string;
  teamId?: string;
  previousSettings: AgentSettings | null;
  nextMcpServers: AgentSettings["mcpServers"] | undefined;
}): Promise<void> {
  const {
    queue,
    agentSettingsStore,
    agentId,
    userId,
    platform,
    channelId,
    conversationId,
    teamId,
    previousSettings,
    nextMcpServers,
  } = options;

  const previousMcpIds = getEnabledHttpMcpIds(previousSettings?.mcpServers);
  const previousNotified = { ...(previousSettings?.mcpInstallNotified || {}) };
  const currentMcpIds = getEnabledHttpMcpIds(nextMcpServers);

  const candidatesToNotify = Array.from(currentMcpIds).filter(
    (mcpId) => !previousMcpIds.has(mcpId) && !previousNotified[mcpId]
  );

  if (candidatesToNotify.length === 0) return;

  await queue.createQueue("thread_response");

  const notifiedUpdates: Record<string, number> = { ...previousNotified };
  for (const mcpId of candidatesToNotify) {
    const messageId = `mcp-installed:${agentId}:${mcpId}:${Date.now()}`;
    try {
      await queue.send("thread_response", {
        messageId,
        channelId,
        conversationId,
        userId,
        teamId: teamId || "no-team",
        platform,
        content: `MCP "${mcpId}" is installed and ready. You can use it in this chat on your next message.`,
        timestamp: Date.now(),
        ephemeral: true,
      });
      notifiedUpdates[mcpId] = Date.now();
      logger.info("Sent MCP installed notification", {
        agentId,
        mcpId,
        channelId,
        conversationId,
      });
    } catch (error) {
      logger.warn("Failed to send MCP installed notification", {
        agentId,
        mcpId,
        error,
      });
    }
  }

  const changed =
    Object.keys(notifiedUpdates).length !==
    Object.keys(previousNotified).length;
  if (changed) {
    await agentSettingsStore.updateSettings(agentId, {
      mcpInstallNotified: notifiedUpdates,
    });
  }
}
