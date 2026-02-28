/**
 * Agent Config Routes
 *
 * Configuration endpoints mounted under /api/v1/agents/{agentId}/config
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { type AuthProfile, createLogger } from "@lobu/core";
import type { AgentMetadataStore } from "../../auth/agent-metadata-store";
import type { ProviderCatalogService } from "../../auth/provider-catalog";
import { collectModelValues } from "../../auth/provider-model-options";
import type { ProviderStatus } from "../../auth/provider-status";
import type { AgentSettings, AgentSettingsStore } from "../../auth/settings";
import type { AuthProfilesManager } from "../../auth/settings/auth-profiles-manager";
import {
  type SettingsTokenPayload,
  verifySettingsToken,
} from "../../auth/settings/token-service";
import type { UserAgentsStore } from "../../auth/user-agents-store";
import type { WorkerConnectionManager } from "../../gateway/connection-manager";
import type { IMessageQueue } from "../../infrastructure/queue";
import type { GrantStore } from "../../permissions/grant-store";

const TAG = "Agents";
const ErrorResponse = z.object({ error: z.string() });
const TokenQuery = z.object({ token: z.string() });
const logger = createLogger("agent-config-routes");
const REDACTED_VALUE = "__LOBU_REDACTED__";
const SENSITIVE_KEY_PATTERN =
  /(?:credential|secret|token|password|api(?:_|-)?key|authorization)/i;

interface RedactedFieldState {
  redacted: true;
  hasValue: boolean;
}

type SanitizedAuthProfile = Omit<AuthProfile, "credential" | "metadata"> & {
  credential: string;
  credentialRedacted: true;
  metadata?: Omit<NonNullable<AuthProfile["metadata"]>, "refreshToken"> & {
    refreshToken?: string;
    refreshTokenRedacted?: true;
  };
};

type PublicAgentSettings = Omit<AgentSettings, "envVars" | "authProfiles"> & {
  envVars?: Record<string, string>;
  envVarsMeta?: Record<string, RedactedFieldState>;
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
          schema: z.object({
            agentId: z.string(),
            settings: z.any(),
            providers: z.record(
              z.string(),
              z.object({
                connected: z.boolean(),
                userConnected: z.boolean(),
                systemConnected: z.boolean(),
              })
            ),
          }),
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
            envVars: z.record(z.string(), z.string()).optional(),
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
                    slot: z.enum(["tool", "provider"]),
                    enabled: z.boolean().optional(),
                  })
                ),
              })
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
}

export function createAgentConfigRoutes(
  config: AgentConfigRoutesConfig
): OpenAPIHono {
  const app = new OpenAPIHono();

  /**
   * Verify settings token against agentId.
   * If token has agentId, it must match. If token has no agentId (channel-based),
   * verify user owns the agent via userAgentsStore or it's a workspace agent.
   */
  const verifyToken = async (
    token: string | undefined,
    agentId: string
  ): Promise<SettingsTokenPayload | null> => {
    if (!token) return null;
    const payload = verifySettingsToken(token);
    if (!payload) return null;

    if (payload.agentId) {
      // Agent-based token: must match exactly
      if (payload.agentId !== agentId) return null;
    } else {
      // Channel-based token: verify user owns the agent
      if (config.userAgentsStore) {
        const owns = await config.userAgentsStore.ownsAgent(
          payload.platform,
          payload.userId,
          agentId
        );
        if (!owns) {
          // Check workspace agent fallback
          if (config.agentMetadataStore) {
            const metadata =
              await config.agentMetadataStore.getMetadata(agentId);
            if (!metadata?.isWorkspaceAgent) return null;
          } else {
            return null;
          }
        }
      }
    }
    return payload;
  };

  app.openapi(getConfigRoute, async (c): Promise<any> => {
    const agentId = c.req.param("agentId") || "";
    const payload = await verifyToken(c.req.valid("query").token, agentId);
    if (!payload) return c.json({ error: "Unauthorized" }, 401);

    const settings = await config.agentSettingsStore.getSettings(agentId);

    // Provider status
    const providers: Record<string, ProviderStatus> = {};
    if (config.providerStores) {
      for (const [name, store] of Object.entries(config.providerStores)) {
        try {
          const hasSystemCredentials =
            config.providerConnectedOverrides?.[name] === true;
          const hasUserCredentials = await store.hasCredentials(agentId);

          const profiles = config.authProfilesManager
            ? await config.authProfilesManager.getProviderProfiles(
                agentId,
                name
              )
            : [];
          const now = Date.now();
          const validProfiles = profiles.filter(
            (p) => !p.metadata?.expiresAt || p.metadata.expiresAt > now
          );

          providers[name] = {
            connected: hasUserCredentials || hasSystemCredentials,
            userConnected: hasUserCredentials,
            systemConnected: hasSystemCredentials,
            activeAuthType: validProfiles[0]?.authType,
            authMethods: validProfiles.map((p, i) => ({
              profileId: p.id,
              authType: p.authType,
              label: p.label,
              isPrimary: i === 0,
            })),
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

    return c.json({
      agentId,
      settings: sanitizeSettingsForResponse(settings),
      providers,
    });
  });

  app.openapi(updateConfigRoute, async (c): Promise<any> => {
    const agentId = c.req.param("agentId") || "";
    const payload = await verifyToken(c.req.valid("query").token, agentId);
    if (!payload) return c.json({ error: "Unauthorized" }, 401);

    try {
      const existingSettings =
        await config.agentSettingsStore.getSettings(agentId);
      const availableModels = await collectModelValues(agentId, payload.userId);
      const body = restoreRedactedSentinels(
        c.req.valid("json"),
        existingSettings || {}
      );

      const updates: Partial<AgentSettings> = {};

      // Handle explicit null for nixConfig (clear)
      if (body.nixConfig === null) {
        updates.nixConfig = undefined;
        delete body.nixConfig;
      }

      if (Object.keys(body).length > 0) {
        const validated = await validateSettings(
          body as Partial<AgentSettings>,
          availableModels
        );
        Object.assign(updates, validated);
      }

      if (Object.keys(updates).length > 0) {
        await config.agentSettingsStore.updateSettings(agentId, updates);

        // Notify active workers of config changes
        config.connectionManager?.notifyAgent(agentId, "config_changed", {});
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

  // GET /packages/search?q=python
  app.get("/packages/search", async (c): Promise<any> => {
    const agentId = c.req.param("agentId") || "";
    const token = c.req.query("token");
    const payload = await verifyToken(token, agentId);
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
    const token = c.req.query("token");
    const payload = await verifyToken(token, agentId);
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

  // POST /providers/install
  app.post("/providers/install", async (c): Promise<any> => {
    const agentId = c.req.param("agentId") || "";
    const token = c.req.query("token");
    const payload = await verifyToken(token, agentId);
    if (!payload) return c.json({ error: "Unauthorized" }, 401);

    if (!config.providerCatalogService) {
      return c.json({ error: "Provider catalog not available" }, 503);
    }

    try {
      const body = await c.req.json();
      const { providerId, config: providerConfig } = body;
      if (!providerId || typeof providerId !== "string") {
        return c.json({ error: "providerId is required" }, 400);
      }

      await config.providerCatalogService.installProvider(
        agentId,
        providerId.trim(),
        providerConfig
      );
      config.connectionManager?.notifyAgent(agentId, "config_changed", {});
      return c.json({ success: true, agentId });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "Install failed" },
        400
      );
    }
  });

  // POST /providers/uninstall
  app.post("/providers/uninstall", async (c): Promise<any> => {
    const agentId = c.req.param("agentId") || "";
    const token = c.req.query("token");
    const payload = await verifyToken(token, agentId);
    if (!payload) return c.json({ error: "Unauthorized" }, 401);

    if (!config.providerCatalogService) {
      return c.json({ error: "Provider catalog not available" }, 503);
    }

    try {
      const body = await c.req.json();
      const { providerId } = body;
      if (!providerId || typeof providerId !== "string") {
        return c.json({ error: "providerId is required" }, 400);
      }

      await config.providerCatalogService.uninstallProvider(
        agentId,
        providerId.trim()
      );
      config.connectionManager?.notifyAgent(agentId, "config_changed", {});
      return c.json({ success: true, agentId });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "Uninstall failed" },
        400
      );
    }
  });

  // PATCH /providers/reorder
  app.patch("/providers/reorder", async (c): Promise<any> => {
    const agentId = c.req.param("agentId") || "";
    const token = c.req.query("token");
    const payload = await verifyToken(token, agentId);
    if (!payload) return c.json({ error: "Unauthorized" }, 401);

    if (!config.providerCatalogService) {
      return c.json({ error: "Provider catalog not available" }, 503);
    }

    try {
      const body = await c.req.json();
      const { providerIds } = body;
      if (!Array.isArray(providerIds)) {
        return c.json({ error: "providerIds array is required" }, 400);
      }

      await config.providerCatalogService.reorderProviders(
        agentId,
        providerIds.filter((id): id is string => typeof id === "string")
      );
      config.connectionManager?.notifyAgent(agentId, "config_changed", {});
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
      const token = c.req.query("token");
      const payload = await verifyToken(token, agentId);
      if (!payload) return c.json({ error: "Unauthorized" }, 401);

      const grants = await grantStore.listGrants(agentId);
      return c.json(grants);
    });

    // POST /grants - Create a grant
    app.post("/grants", async (c) => {
      const agentId = c.req.param("agentId") || "";
      const token = c.req.query("token");
      const payload = await verifyToken(token, agentId);
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
      const token = c.req.query("token");
      const payload = await verifyToken(token, agentId);
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
  const envVars = settings.envVars || {};

  if (Object.keys(envVars).length > 0) {
    const redactedEnvVars: Record<string, string> = {};
    const envVarsMeta: Record<string, RedactedFieldState> = {};

    for (const [key, value] of Object.entries(envVars)) {
      redactedEnvVars[key] = REDACTED_VALUE;
      envVarsMeta[key] = { redacted: true, hasValue: value.length > 0 };
    }

    sanitized.envVars = redactedEnvVars;
    sanitized.envVarsMeta = envVarsMeta;
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
  availableModels: Set<string>
): Promise<Omit<AgentSettings, "updatedAt">> {
  const settings: Omit<AgentSettings, "updatedAt"> = {};

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
    } else {
      if (availableModels.size === 0) {
        throw new Error(
          "No models are currently available from configured providers."
        );
      }
      if (!availableModels.has(cleanModel)) {
        throw new Error(`Invalid model: ${cleanModel}`);
      }
      settings.model = cleanModel;
    }
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

  if (input.envVars && typeof input.envVars === "object") {
    settings.envVars = {};
    for (const [key, value] of Object.entries(input.envVars)) {
      const cleanKey = key.trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(cleanKey)) {
        settings.envVars[cleanKey] = String(value);
      }
    }
  }

  if (input.skillsConfig) {
    settings.skillsConfig = input.skillsConfig;
  }

  if (input.pluginsConfig) {
    settings.pluginsConfig = {
      plugins: input.pluginsConfig.plugins
        .filter((p) => typeof p.source === "string" && p.source.trim())
        .map((p) => ({
          source: p.source.trim(),
          slot: p.slot,
          enabled: p.enabled ?? true,
        })),
    };
  }

  if (typeof input.verboseLogging === "boolean") {
    settings.verboseLogging = input.verboseLogging;
  }

  return settings;
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
