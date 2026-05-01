import {
  type McpOAuthConfig,
  createLogger,
  verifyWorkerToken,
} from "@lobu/core";
import type { ProviderConfigResolver } from "../../services/provider-config-resolver.js";
import type { AgentSettingsStore } from "../settings/agent-settings-store.js";

const logger = createLogger("mcp-config-service");
const LOBU_MEMORY_MCP_ID = "lobu-memory";

interface McpInput {
  type: "promptString";
  id: string;
  description: string;
}

interface HttpMcpServerConfig {
  id: string;
  upstreamUrl: string;
  oauth?: McpOAuthConfig;
  inputs?: McpInput[];
  headers?: Record<string, string>;
  /**
   * Credential scope for OAuth flows.
   * - "user" (default): per-user credential — each chat user authenticates separately.
   * - "channel": credential is shared across all users in a conversation/channel
   *   (keyed by channelId). For shared-data integrations where per-user identity
   *   isn't required. Must be explicitly opted in via `auth_scope = "channel"`
   *   in lobu.toml.
   */
  authScope?: "user" | "channel";
  /**
   * Marks an MCP whose upstream is the same embedded Owletto process. The
   * gateway proxy passes the worker JWT directly (no OAuth), bypasses the
   * SSRF localhost guard, and stamps the upstream request with the
   * direct-auth header so Owletto promotes it to admin scope.
   */
  internal?: boolean;
}

interface WorkerMcpConfig {
  mcpServers: Record<string, any>;
}

interface McpStatus {
  id: string;
  name: string;
  requiresAuth: boolean;
  requiresInput: boolean;
}

interface LoadedConfig {
  rawServers: Record<string, any>;
  httpServers: Map<string, HttpMcpServerConfig>;
}

interface LobuMemoryConfigOptions {
  publicBaseUrl?: string;
  resolveOrgSlug?: (agentId: string) => Promise<string | null>;
}

interface McpConfigServiceOptions {
  agentSettingsStore?: AgentSettingsStore;
  configResolver?: ProviderConfigResolver;
  lobuMemory?: LobuMemoryConfigOptions;
}

export class McpConfigService {
  private cache?: LoadedConfig;
  private agentSettingsStore?: AgentSettingsStore;
  private configResolver?: ProviderConfigResolver;
  private lobuMemory?: LobuMemoryConfigOptions;

  constructor(options: McpConfigServiceOptions = {}) {
    this.agentSettingsStore = options.agentSettingsStore;
    this.configResolver = options.configResolver;
    this.lobuMemory = options.lobuMemory;
    logger.debug(`McpConfigService initialized`);
  }

  /**
   * Register additional global MCP servers.
   */
  registerGlobalServers(servers: Record<string, any>): void {
    if (!this.cache) {
      this.cache = {
        rawServers: {},
        httpServers: new Map(),
      };
    }

    const normalized = normalizeConfig({ mcpServers: servers });
    for (const [id, raw] of Object.entries(normalized.rawServers)) {
      if (this.cache.rawServers[id]) continue;
      this.cache.rawServers[id] = raw;
    }
    for (const [id, http] of normalized.httpServers) {
      if (this.cache.httpServers.has(id)) continue;
      this.cache.httpServers.set(id, http);
    }

    logger.info(
      `Registered ${Object.keys(servers).length} global MCP(s): ${Object.keys(servers).join(", ")}`
    );
  }

  /**
   * Register or replace a single global MCP server. Global MCPs are fallback
   * defaults only; explicit per-agent MCP settings override them.
   */
  upsertGlobalServer(id: string, serverConfig: Record<string, any>): void {
    if (!this.cache) {
      this.cache = {
        rawServers: {},
        httpServers: new Map(),
      };
    }

    const normalized = normalizeConfig({ mcpServers: { [id]: serverConfig } });
    const raw = normalized.rawServers[id];
    if (raw) {
      this.cache.rawServers[id] = raw;
    }
    const http = normalized.httpServers.get(id);
    if (http) {
      this.cache.httpServers.set(id, http);
    } else {
      this.cache.httpServers.delete(id);
    }

    logger.info(`Upserted global MCP "${id}"`);
  }

  /**
   * Return MCP config tailored for a worker request.
   */
  async getWorkerConfig(options: {
    baseUrl: string;
    workerToken: string;
    deploymentName?: string;
  }): Promise<WorkerMcpConfig> {
    const { baseUrl, workerToken } = options;
    const config = await this.loadConfig();
    const workerConfig: WorkerMcpConfig = { mcpServers: {} };

    const tokenData = verifyWorkerToken(workerToken);
    if (!tokenData) {
      logger.warn("Failed to verify worker token");
      return workerConfig;
    }

    const { userId, agentId } = tokenData;
    const effectiveAgentId = agentId || userId;
    logger.info(`Building MCP config for user ${userId}`);

    // Process global MCPs
    for (const [id, serverConfig] of Object.entries(config.rawServers)) {
      const cloned = cloneConfig(serverConfig);
      const httpServer = config.httpServers.get(id);

      if (httpServer) {
        logger.info(`Configuring global MCP ${id}: baseUrl=${baseUrl}`);
        cloned.url = baseUrl;
        cloned.type = "sse";
        cloned.headers = mergeHeaders(cloned.headers, workerToken, id);
        logger.info(
          `Including global MCP ${id} with URL=${cloned.url} and X-Mcp-Id header`
        );
      }

      workerConfig.mcpServers[id] = cloned;
    }

    // Merge per-agent MCPs from live agent settings. Per-agent settings are
    // authoritative: they override global fallback entries, and `enabled:false`
    // disables a same-id global default for this agent.
    const agentSettingsMcpServers = await this.getEffectiveAgentMcpServers(
      effectiveAgentId
    );
    for (const [id, serverConfig] of Object.entries(agentSettingsMcpServers)) {
      const cloned = cloneConfig(serverConfig);

      if (cloned.enabled === false) {
        logger.debug(`Skipping disabled per-agent MCP ${id}`);
        delete workerConfig.mcpServers[id];
        continue;
      }

      if (workerConfig.mcpServers[id]) {
        logger.info(`Per-agent MCP ${id} overrides global MCP with same ID`);
      }

      if (cloned.url) {
        logger.info(`Configuring per-agent HTTP MCP ${id}: baseUrl=${baseUrl}`);
        cloned.originalUrl = cloned.url;
        cloned.url = baseUrl;
        cloned.type = "sse";
        cloned.headers = mergeHeaders(cloned.headers, workerToken, id);
        cloned.perAgent = true;
        logger.info(`Including per-agent HTTP MCP ${id}`);
      } else if (cloned.command) {
        logger.info(`Including per-agent stdio MCP ${id}: ${cloned.command}`);
      }

      workerConfig.mcpServers[id] = cloned;
    }

    if (Object.keys(agentSettingsMcpServers).length > 0) {
      logger.info(
        `Merged ${Object.keys(agentSettingsMcpServers).length} per-agent MCPs from settings for agent ${effectiveAgentId}`
      );
    }

    logger.info(
      `Returning worker config with ${Object.keys(workerConfig.mcpServers).length} MCPs for user ${userId}:`,
      {
        mcpIds: Object.keys(workerConfig.mcpServers),
        configs: Object.entries(workerConfig.mcpServers).map(([id, cfg]) => ({
          id,
          type: cfg.type,
          hasUrl: !!cfg.url,
          hasCommand: !!cfg.command,
          perAgent: cfg.perAgent || false,
        })),
      }
    );

    return workerConfig;
  }

  /**
   * Get status of all MCPs for a specific agent
   */
  async getMcpStatus(agentId: string): Promise<McpStatus[]> {
    const httpServers = await this.getAllHttpServers(agentId);
    const statuses: McpStatus[] = [];

    for (const [id, httpServer] of httpServers) {
      const requiresAuth = !!httpServer.oauth;
      const requiresInput = !!(
        httpServer.inputs && httpServer.inputs.length > 0
      );

      statuses.push({
        id,
        name: id,
        requiresAuth,
        requiresInput,
      });
    }

    return statuses;
  }

  /**
   * Get HTTP proxy metadata for a specific MCP server.
   */
  async getHttpServer(
    id: string,
    agentId?: string
  ): Promise<HttpMcpServerConfig | undefined> {
    const httpServers = await this.getAllHttpServers(agentId);
    return httpServers.get(id);
  }

  /**
   * Get all HTTP proxy metadata for all MCP servers.
   */
  async getAllHttpServers(
    agentId?: string
  ): Promise<Map<string, HttpMcpServerConfig>> {
    const config = await this.loadConfig();
    const merged = new Map(config.httpServers);

    if (agentId) {
      const agentMcpServers = await this.getEffectiveAgentMcpServers(agentId);
      for (const [id, serverConfig] of Object.entries(agentMcpServers)) {
        if (serverConfig?.enabled === false) {
          merged.delete(id);
          continue;
        }
        const httpServer = toHttpServerConfig(id, serverConfig);
        if (httpServer) {
          merged.set(id, httpServer);
        } else if (merged.has(id)) {
          merged.delete(id);
        }
      }
    }

    return merged;
  }

  /**
   * Return global MCP server configs in settings-compatible format.
   */
  async getGlobalMcpServers(): Promise<
    Record<string, { url?: string; type?: "sse" | "stdio" | "streamable-http" }>
  > {
    const config = await this.loadConfig();
    const result: Record<
      string,
      { url?: string; type?: "sse" | "stdio" | "streamable-http" }
    > = {};
    for (const [id, raw] of Object.entries(config.rawServers)) {
      const declared = raw.type;
      const type: "sse" | "stdio" | "streamable-http" =
        declared === "stdio"
          ? "stdio"
          : declared === "streamable-http"
            ? "streamable-http"
            : "sse";
      result[id] = { url: raw.url, type };
    }
    return result;
  }

  private async getEffectiveAgentMcpServers(
    agentId: string
  ): Promise<Record<string, any>> {
    const servers = await this.getAgentMcpServers(agentId);
    const derived = await this.deriveLobuMemoryServer(agentId);
    if (!derived) {
      const withoutLobuMemory = { ...servers };
      delete withoutLobuMemory["lobu-memory"];
      return withoutLobuMemory;
    }

    const existing = servers["lobu-memory"];
    if (existing && typeof existing === "object") {
      return {
        ...servers,
        "lobu-memory": {
          ...existing,
          url: derived.url,
          type: derived.type,
          internal: true,
        },
      };
    }

    return {
      ...servers,
      "lobu-memory": derived,
    };
  }

  private async getAgentMcpServers(
    agentId: string
  ): Promise<Record<string, any>> {
    let servers: Record<string, any> = {};

    if (this.agentSettingsStore) {
      try {
        const settings =
          await this.agentSettingsStore.getEffectiveSettings(agentId);
        servers = { ...(settings?.mcpServers || {}) };
      } catch (error) {
        logger.warn(`Failed to load per-agent MCP settings for ${agentId}`, {
          error,
        });
      }
    }

    if (!servers[LOBU_MEMORY_MCP_ID]) {
      const derived = await this.resolveLobuMemoryServer(agentId);
      if (derived) {
        servers[LOBU_MEMORY_MCP_ID] = derived;
      }
    }

    return servers;
  }

  private async resolveLobuMemoryServer(
    agentId: string
  ): Promise<Record<string, any> | null> {
    const baseUrl = this.lobuMemory?.publicBaseUrl?.trim();
    const resolveOrgSlug = this.lobuMemory?.resolveOrgSlug;
    if (!baseUrl || !resolveOrgSlug) return null;

    try {
      const orgSlug = await resolveOrgSlug(agentId);
      if (!orgSlug) return null;
      return {
        url: buildLobuMemoryScopedMcpUrl(baseUrl, orgSlug),
        type: "streamable-http",
      };
    } catch (error) {
      logger.warn(`Failed to resolve ${LOBU_MEMORY_MCP_ID} for ${agentId}`, {
        error,
      });
      return null;
    }
  }

  private async deriveLobuMemoryServer(
    agentId: string
  ): Promise<Record<string, any> | null> {
    const resolveOrgSlug = this.lobuMemory?.resolveOrgSlug;
    if (!resolveOrgSlug) {
      return null;
    }

    try {
      const orgSlug = await resolveOrgSlug(agentId);
      if (!orgSlug) {
        return null;
      }
      const publicBaseUrl = (this.lobuMemory?.publicBaseUrl || "").replace(
        /\/+$/,
        ""
      );
      if (!publicBaseUrl) {
        logger.warn(
          `Cannot derive lobu-memory MCP for ${agentId}: public base URL is not configured`
        );
        return null;
      }
      return {
        url: `${publicBaseUrl}/mcp/${encodeURIComponent(orgSlug)}`,
        type: "streamable-http",
        internal: true,
      };
    } catch (error) {
      logger.warn(`Failed to derive lobu-memory MCP for ${agentId}`, { error });
      return null;
    }
  }

  private async loadConfig(): Promise<LoadedConfig> {
    if (!this.cache) {
      let globalMcpServers: Record<string, any> = {};
      if (this.configResolver) {
        globalMcpServers = await this.configResolver.getGlobalMcpServers();
      }
      const normalized = normalizeConfig({ mcpServers: globalMcpServers });
      this.cache = normalized;
    }
    return this.cache;
  }
}

/**
 * Parse and validate an oauth config from raw MCP server config.
 * Handles backward compat: migrates top-level `resource` into `oauth.resource`,
 * and treats `loginUrl` presence as `oauth: {}` (requiresAuth flag).
 */
function parseOAuthConfig(raw: any): McpOAuthConfig | undefined {
  const hasLoginUrl = typeof raw.loginUrl === "string";
  const hasOAuth = raw.oauth && typeof raw.oauth === "object";

  if (!hasOAuth && !hasLoginUrl && typeof raw.resource !== "string") {
    return undefined;
  }

  const config: McpOAuthConfig = {};

  if (hasOAuth) {
    const obj = raw.oauth;
    if (typeof obj.authUrl === "string") config.authUrl = obj.authUrl;
    if (typeof obj.tokenUrl === "string") config.tokenUrl = obj.tokenUrl;
    if (typeof obj.clientId === "string") config.clientId = obj.clientId;
    if (typeof obj.clientSecret === "string")
      config.clientSecret = obj.clientSecret;
    if (Array.isArray(obj.scopes))
      config.scopes = obj.scopes.filter((s: unknown) => typeof s === "string");
    if (typeof obj.deviceAuthorizationUrl === "string")
      config.deviceAuthorizationUrl = obj.deviceAuthorizationUrl;
    if (typeof obj.registrationUrl === "string")
      config.registrationUrl = obj.registrationUrl;
    if (typeof obj.resource === "string") config.resource = obj.resource;
  }

  // Migrate top-level resource into oauth.resource (backward compat)
  if (typeof raw.resource === "string" && !config.resource) {
    config.resource = raw.resource;
  }

  return config;
}

function normalizeConfig(config: { mcpServers: Record<string, any> }) {
  const rawServers: Record<string, any> = {};
  const httpServers = new Map<string, HttpMcpServerConfig>();

  for (const [id, serverConfig] of Object.entries(config.mcpServers)) {
    if (!serverConfig || typeof serverConfig !== "object") {
      continue;
    }

    const cloned = cloneConfig(serverConfig);
    rawServers[id] = cloned;

    if (typeof cloned.url === "string" && isHttpUrl(cloned.url)) {
      httpServers.set(id, {
        id,
        upstreamUrl: cloned.url,
        oauth: parseOAuthConfig(cloned),
        inputs: Array.isArray(cloned.inputs)
          ? cloned.inputs.filter(
              (input: any) =>
                input &&
                typeof input === "object" &&
                input.type === "promptString"
            )
          : undefined,
        headers:
          cloned.headers && typeof cloned.headers === "object"
            ? cloned.headers
            : undefined,
        authScope: parseAuthScope(cloned),
        internal: cloned.internal === true,
      });
    }
  }

  return { rawServers, httpServers };
}

function toHttpServerConfig(
  id: string,
  serverConfig: any
): HttpMcpServerConfig | null {
  if (!serverConfig || typeof serverConfig !== "object") {
    return null;
  }

  if (serverConfig.enabled === false) {
    return null;
  }

  const cloned = cloneConfig(serverConfig);
  if (typeof cloned.url !== "string" || !isHttpUrl(cloned.url)) {
    return null;
  }

  return {
    id,
    upstreamUrl: cloned.url,
    oauth: parseOAuthConfig(cloned),
    inputs: Array.isArray(cloned.inputs)
      ? cloned.inputs.filter(
          (input: any) =>
            input && typeof input === "object" && input.type === "promptString"
        )
      : undefined,
    headers:
      cloned.headers && typeof cloned.headers === "object"
        ? cloned.headers
        : undefined,
    authScope: parseAuthScope(cloned),
    internal: cloned.internal === true,
  };
}

function parseAuthScope(raw: any): "user" | "channel" | undefined {
  const value =
    typeof raw.authScope === "string"
      ? raw.authScope
      : typeof raw.auth_scope === "string"
        ? raw.auth_scope
        : undefined;
  if (value === "user" || value === "channel") return value;
  return undefined;
}

function cloneConfig(config: any) {
  return JSON.parse(JSON.stringify(config));
}

export function buildLobuMemoryScopedMcpUrl(baseUrl: string, orgSlug: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/mcp/${orgSlug}`;
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

function isHttpUrl(candidate: string): boolean {
  return candidate.startsWith("http://") || candidate.startsWith("https://");
}

function mergeHeaders(
  existingHeaders: unknown,
  workerToken: string,
  mcpId: string
): Record<string, string> {
  const normalized: Record<string, string> = {};

  if (existingHeaders && typeof existingHeaders === "object") {
    for (const [key, value] of Object.entries(existingHeaders as any)) {
      if (typeof value === "string") {
        normalized[key] = value;
      } else if (value != null) {
        normalized[key] = String(value);
      }
    }
  }

  normalized.Authorization = `Bearer ${workerToken}`;
  normalized["X-Mcp-Id"] = mcpId;
  return normalized;
}
