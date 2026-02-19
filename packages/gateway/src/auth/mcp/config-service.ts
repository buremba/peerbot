import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, verifyWorkerToken } from "@lobu/core";
import { z } from "zod";
import type { AgentSettingsStore } from "../settings/agent-settings-store";
import type {
  DiscoveredOAuthMetadata,
  OAuthDiscoveryService,
} from "../oauth/discovery";
import type { McpCredentialStore } from "./credential-store";
import type { McpInputStore } from "./input-store";
import { mcpConfigStore } from "./mcp-config-store";

const logger = createLogger("mcp-config-service");

const McpServersSchema = z.object({
  mcpServers: z.record(z.string(), z.any()),
});

type RawMcpConfig = z.infer<typeof McpServersSchema>;

export interface OAuth2Config {
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string; // Supports ${env:VAR_NAME} substitution
  scopes?: string[];
  grantType?: string;
  responseType?: string;
  tokenEndpointAuthMethod?: string; // e.g., "none" for PKCE, "client_secret_post" for client secret
}

interface McpInput {
  type: "promptString";
  id: string;
  description: string;
}

interface HttpMcpServerConfig {
  id: string;
  upstreamUrl: string;
  oauth?: OAuth2Config;
  inputs?: McpInput[];
  headers?: Record<string, string>;
  loginUrl?: string; // Simple OAuth marker - indicates MCP requires auth
}

interface WorkerMcpConfig {
  mcpServers: Record<string, any>;
}

interface McpStatus {
  id: string;
  name: string;
  requiresAuth: boolean;
  requiresInput: boolean;
  authenticated: boolean;
  configured: boolean;
}

interface LoadedConfig {
  rawServers: Record<string, any>;
  httpServers: Map<string, HttpMcpServerConfig>;
  mtimeMs: number;
  discoveredOAuth?: Map<string, DiscoveredOAuthMetadata>;
}

type ConfigSource = { type: "file"; path: string } | { type: "http"; url: URL };

interface McpConfigServiceOptions {
  configUrl?: string; // Accepts both URLs (http://, https://) and file paths
  discoveryService?: OAuthDiscoveryService;
  credentialStore?: McpCredentialStore;
  inputStore?: McpInputStore;
  agentSettingsStore?: AgentSettingsStore;
}

export class McpConfigService {
  private source?: ConfigSource;
  private cache?: LoadedConfig;
  private discoveryService?: OAuthDiscoveryService;
  private credentialStore?: McpCredentialStore;
  private inputStore?: McpInputStore;
  private agentSettingsStore?: AgentSettingsStore;
  private discoveryEnriched = false;

  constructor(options: McpConfigServiceOptions = {}) {
    this.discoveryService = options.discoveryService;
    this.credentialStore = options.credentialStore;
    this.inputStore = options.inputStore;
    this.agentSettingsStore = options.agentSettingsStore;
    logger.info(
      `McpConfigService initialized with discovery: ${!!this.discoveryService}, credential store: ${!!this.credentialStore}, input store: ${!!this.inputStore}`
    );

    if (!options.configUrl) {
      logger.warn("No MCP config location provided");
      return;
    }

    logger.info(`MCP config location: ${options.configUrl}`);
    this.source = this.resolveConfigSource(options.configUrl);
  }

  /**
   * Return MCP config tailored for a worker request.
   * Returns ALL MCPs (global + per-agent) - worker will filter them based on status
   */
  async getWorkerConfig(options: {
    baseUrl: string;
    workerToken: string;
    deploymentName?: string;
  }): Promise<WorkerMcpConfig> {
    const { baseUrl, workerToken, deploymentName } = options;
    const config = await this.loadConfig();
    const workerConfig: WorkerMcpConfig = { mcpServers: {} };

    // Extract userId from worker token for logging
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
        // Configure HTTP MCP - send ALL MCPs, worker will filter based on status
        // Since Claude Code HTTP transport strips paths, use root URL with X-Mcp-Id header
        logger.info(`🔧 Configuring global MCP ${id}: baseUrl=${baseUrl}`);
        cloned.url = baseUrl; // Use base URL only (e.g., http://gateway:8080)
        cloned.type = "sse"; // Mark as SSE server for SDK
        cloned.headers = mergeHeaders(cloned.headers, workerToken, id);

        logger.info(
          `✅ Including global MCP ${id} with URL=${cloned.url} and X-Mcp-Id header`
        );
      }

      workerConfig.mcpServers[id] = cloned;
    }

    // Merge per-agent MCPs from live agent settings (preferred, no deployment restart required)
    const agentSettingsMcpServers =
      (await this.getAgentMcpServers(effectiveAgentId)) || {};
    for (const [id, serverConfig] of Object.entries(agentSettingsMcpServers)) {
      // Per-agent MCPs are additive - skip if global MCP with same ID exists
      if (workerConfig.mcpServers[id]) {
        logger.warn(
          `Per-agent MCP ${id} skipped - global MCP with same ID exists`
        );
        continue;
      }

      const cloned = cloneConfig(serverConfig);

      if (cloned.enabled === false) {
        logger.debug(`Skipping disabled per-agent MCP ${id}`);
        continue;
      }

      if (cloned.url) {
        // HTTP/SSE MCP - proxy through gateway
        logger.info(
          `🔧 Configuring per-agent HTTP MCP ${id}: baseUrl=${baseUrl}`
        );
        // Store original URL for proxy forwarding (used by MCP proxy)
        cloned.originalUrl = cloned.url;
        cloned.url = baseUrl;
        cloned.type = "sse";
        cloned.headers = mergeHeaders(cloned.headers, workerToken, id);
        cloned.perAgent = true; // Mark as per-agent for proxy routing
        logger.info(`✅ Including per-agent HTTP MCP ${id}`);
      } else if (cloned.command) {
        // Stdio MCP - runs directly in worker container
        logger.info(
          `✅ Including per-agent stdio MCP ${id}: ${cloned.command}`
        );
      }

      workerConfig.mcpServers[id] = cloned;
    }

    if (Object.keys(agentSettingsMcpServers).length > 0) {
      logger.info(
        `Merged ${Object.keys(agentSettingsMcpServers).length} per-agent MCPs from settings for agent ${effectiveAgentId}`
      );
    }

    // Legacy fallback: merge deployment-scoped MCPs if present
    if (deploymentName) {
      const agentMcpConfig = await mcpConfigStore.get(deploymentName);
      if (agentMcpConfig?.mcpServers) {
        for (const [id, serverConfig] of Object.entries(
          agentMcpConfig.mcpServers
        )) {
          // Per-agent MCPs are additive - skip if global MCP with same ID exists
          if (workerConfig.mcpServers[id]) {
            logger.warn(
              `Per-agent MCP ${id} skipped - global MCP with same ID exists`
            );
            continue;
          }

          const cloned = cloneConfig(serverConfig);

          if (cloned.url) {
            // HTTP/SSE MCP - proxy through gateway
            logger.info(
              `🔧 Configuring per-agent HTTP MCP ${id}: baseUrl=${baseUrl}`
            );
            // Store original URL for proxy forwarding (used by MCP proxy)
            cloned.originalUrl = cloned.url;
            cloned.url = baseUrl;
            cloned.type = "sse";
            cloned.headers = mergeHeaders(cloned.headers, workerToken, id);
            cloned.perAgent = true; // Mark as per-agent for proxy routing
            logger.info(`✅ Including per-agent HTTP MCP ${id}`);
          } else if (cloned.command) {
            // Stdio MCP - runs directly in worker container
            logger.info(
              `✅ Including per-agent stdio MCP ${id}: ${cloned.command}`
            );
          }

          workerConfig.mcpServers[id] = cloned;
        }

        logger.info(
          `Merged ${Object.keys(agentMcpConfig.mcpServers).length} per-agent MCPs for deployment ${deploymentName}`
        );
      }
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
   * Get status of all MCPs for a specific space (auth/config state)
   */
  async getMcpStatus(agentId: string): Promise<McpStatus[]> {
    const httpServers = await this.getAllHttpServers(agentId);
    const statuses: McpStatus[] = [];

    for (const [id, httpServer] of httpServers) {
      // Check if MCP requires authentication
      const hasOAuth = !!httpServer.oauth;
      const discoveredOAuth = hasOAuth
        ? undefined
        : await this.ensureDiscoveredOAuth(id, httpServer.upstreamUrl);
      const hasDiscoveredOAuth = !!discoveredOAuth;
      const hasLoginUrl = !!httpServer.loginUrl;
      const requiresAuth = hasOAuth || hasDiscoveredOAuth || hasLoginUrl;

      // Check if MCP requires input configuration
      const requiresInput = !!(
        httpServer.inputs && httpServer.inputs.length > 0
      );

      // Check authentication status
      let authenticated = false;
      if (requiresAuth && this.credentialStore) {
        const credentials = await this.credentialStore.getCredentials(
          agentId,
          id
        );
        authenticated = !!credentials?.accessToken;
      }

      // Check configuration status
      let configured = false;
      if (requiresInput && this.inputStore) {
        const inputs = await this.inputStore.getInputs(agentId, id);
        configured = !!inputs;
      }

      statuses.push({
        id,
        name: id,
        requiresAuth,
        requiresInput,
        authenticated,
        configured,
      });
    }

    return statuses;
  }

  /**
   * Get HTTP proxy metadata for a specific MCP server.
   */
  async getHttpServer(
    id: string,
    agentId?: string,
    deploymentName?: string
  ): Promise<HttpMcpServerConfig | undefined> {
    const httpServers = await this.getAllHttpServers(agentId, deploymentName);
    return httpServers.get(id);
  }

  /**
   * Get all HTTP proxy metadata for all MCP servers.
   */
  async getAllHttpServers(
    agentId?: string,
    deploymentName?: string
  ): Promise<Map<string, HttpMcpServerConfig>> {
    const config = await this.loadConfig();
    const merged = new Map(config.httpServers);

    if (agentId) {
      const agentMcpServers = await this.getAgentMcpServers(agentId);
      for (const [id, serverConfig] of Object.entries(agentMcpServers)) {
        if (merged.has(id)) continue;
        const httpServer = toHttpServerConfig(id, serverConfig);
        if (httpServer) {
          merged.set(id, httpServer);
        }
      }
    }

    // Legacy fallback: deployment-scoped MCPs
    if (deploymentName) {
      const agentMcpConfig = await mcpConfigStore.get(deploymentName);
      for (const [id, serverConfig] of Object.entries(
        agentMcpConfig?.mcpServers || {}
      )) {
        if (merged.has(id)) continue;
        const httpServer = toHttpServerConfig(id, serverConfig);
        if (httpServer) {
          merged.set(id, httpServer);
        }
      }
    }

    return merged;
  }

  /**
   * Get discovered OAuth metadata for a specific MCP server
   * This reads from the discovery service's cache (Redis) not the in-memory cache
   */
  async getDiscoveredOAuth(
    id: string
  ): Promise<DiscoveredOAuthMetadata | undefined> {
    if (!this.discoveryService) {
      logger.debug(`getDiscoveredOAuth(${id}): no discovery service`);
      return undefined;
    }

    // Read directly from discovery service cache (Redis)
    try {
      const cached = await (this.discoveryService as any).getCachedMetadata?.(
        id
      );
      logger.info(`getDiscoveredOAuth(${id}): found=${!!cached}`);
      return cached || undefined;
    } catch (error) {
      logger.error(`getDiscoveredOAuth(${id}) failed`, { error });
      return undefined;
    }
  }

  private async ensureDiscoveredOAuth(
    id: string,
    upstreamUrl: string
  ): Promise<DiscoveredOAuthMetadata | undefined> {
    const cached = await this.getDiscoveredOAuth(id);
    if (cached) {
      return cached;
    }

    if (!this.discoveryService) {
      return undefined;
    }

    try {
      const discovered = await this.discoveryService.discoverOAuthMetadata(
        id,
        upstreamUrl
      );
      return discovered || undefined;
    } catch (error) {
      logger.debug(`Dynamic OAuth discovery failed for ${id}`, { error });
      return undefined;
    }
  }

  private async getAgentMcpServers(
    agentId: string
  ): Promise<Record<string, any>> {
    if (!this.agentSettingsStore) {
      return {};
    }

    try {
      const settings = await this.agentSettingsStore.getSettings(agentId);
      return settings?.mcpServers || {};
    } catch (error) {
      logger.warn(`Failed to load per-agent MCP settings for ${agentId}`, {
        error,
      });
      return {};
    }
  }

  /**
   * Get all discovered OAuth metadata
   */
  async getAllDiscoveredOAuth(): Promise<Map<string, DiscoveredOAuthMetadata>> {
    const config = await this.loadConfig();
    return config.discoveredOAuth || new Map();
  }

  /**
   * Get the OAuth discovery service
   */
  getDiscoveryService(): OAuthDiscoveryService | undefined {
    return this.discoveryService;
  }

  /**
   * Enrich config with OAuth discovery for all HTTP MCPs
   * Should be called once during gateway initialization
   */
  async enrichWithDiscovery(): Promise<void> {
    if (!this.discoveryService) {
      logger.warn("Discovery skipped - no discovery service");
      return;
    }

    if (this.discoveryEnriched) {
      logger.info("Discovery already completed, skipping");
      return;
    }

    logger.info("Starting OAuth discovery for all MCP servers...");

    const config = await this.loadConfig();
    logger.info(`Found ${config.httpServers.size} HTTP MCP servers to check`);

    const discoveredOAuth = new Map<string, DiscoveredOAuthMetadata>();
    const discoveryPromises: Promise<void>[] = [];

    // Discover OAuth for each HTTP MCP that doesn't have static OAuth config
    for (const [id, serverConfig] of config.httpServers) {
      logger.debug(`Checking MCP ${id} at ${serverConfig.upstreamUrl}`);

      // Skip if OAuth is already configured statically
      if (serverConfig.oauth) {
        logger.debug(
          `Skipping discovery for ${id} - static OAuth config exists`
        );
        continue;
      }

      // Skip if inputs are configured (different auth method)
      if (serverConfig.inputs && serverConfig.inputs.length > 0) {
        logger.debug(
          `Skipping discovery for ${id} - input-based auth configured`
        );
        continue;
      }

      logger.info(
        `Attempting OAuth discovery for ${id} at ${serverConfig.upstreamUrl}`
      );

      // Attempt discovery - fail startup if discovery fails
      const discoveryPromise = this.discoveryService
        .discoverOAuthMetadata(id, serverConfig.upstreamUrl)
        .then((discovered) => {
          if (discovered) {
            discoveredOAuth.set(id, discovered);
            logger.info(
              `✅ Discovered OAuth for ${id}: ${discovered.metadata.issuer}`
            );
          } else {
            throw new Error(
              `OAuth discovery failed for MCP '${id}'. ` +
                `Either add static OAuth config to the MCP JSON file, or ensure the MCP supports RFC 8414/9728 OAuth discovery.`
            );
          }
        });

      discoveryPromises.push(discoveryPromise);
    }

    // Wait for all discovery attempts - fail startup on any error
    await Promise.all(discoveryPromises);

    // Update cache with discovered OAuth
    if (this.cache) {
      this.cache.discoveredOAuth = discoveredOAuth;
    }

    this.discoveryEnriched = true;
    logger.info(
      `Discovery completed. OAuth discovered: ${discoveredOAuth.size}`
    );
  }

  /**
   * Clear discovery cache and re-discover
   */
  async refreshDiscovery(): Promise<void> {
    this.discoveryEnriched = false;
    if (this.cache) {
      this.cache.discoveredOAuth = undefined;
    }
    await this.enrichWithDiscovery();
  }

  private async loadConfig(): Promise<LoadedConfig> {
    if (!this.source) {
      if (!this.cache) {
        this.cache = {
          rawServers: {},
          httpServers: new Map(),
          mtimeMs: 0,
        };
      }
      return this.cache;
    }

    const fallback = this.cache ?? {
      rawServers: {},
      httpServers: new Map(),
      mtimeMs: 0,
    };

    try {
      if (this.source.type === "file") {
        const fileStat = await stat(this.source.path);
        const fileContents = await readFile(this.source.path, "utf-8");
        return this.parseAndCache(fileContents, fileStat.mtimeMs);
      }

      const response = await fetch(this.source.url);
      if (!response.ok) {
        logger.error("Failed to fetch MCP config from remote URL", {
          url: this.source.url.toString(),
          status: response.status,
          statusText: response.statusText,
        });
        return fallback;
      }

      const text = await response.text();
      return this.parseAndCache(text, Date.now());
    } catch (error) {
      logger.error("Error loading MCP config", {
        error,
        source:
          this.source.type === "file"
            ? this.source.path
            : this.source.url.toString(),
      });
      return fallback;
    }
  }

  private resolveConfigSource(location: string): ConfigSource | undefined {
    try {
      const parsed = new URL(location);
      if (parsed.protocol === "file:") {
        return { type: "file", path: fileURLToPath(parsed) };
      }

      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return { type: "http", url: parsed };
      }

      logger.warn("Unsupported MCP config URL protocol; falling back to file", {
        location,
      });
    } catch (_err) {
      // Not a valid URL, treat as path
      return { type: "file", path: path.resolve(location) };
    }

    return { type: "file", path: path.resolve(location) };
  }

  private parseAndCache(rawContents: string, mtimeMs: number): LoadedConfig {
    try {
      const parsed = McpServersSchema.safeParse(JSON.parse(rawContents));
      if (!parsed.success) {
        logger.error("Failed to parse MCP config", {
          issues: parsed.error.issues,
        });
        return (
          this.cache ?? {
            rawServers: {},
            httpServers: new Map(),
            mtimeMs,
          }
        );
      }

      const normalized = normalizeConfig(parsed.data);
      this.cache = {
        rawServers: normalized.rawServers,
        httpServers: normalized.httpServers,
        mtimeMs,
        // Preserve discovery results from enrichWithDiscovery()
        discoveredOAuth: this.cache?.discoveredOAuth,
      };
      return this.cache;
    } catch (error) {
      logger.error("Failed to parse MCP config contents", { error });
      return (
        this.cache ?? {
          rawServers: {},
          httpServers: new Map(),
          mtimeMs,
        }
      );
    }
  }
}

function normalizeConfig(config: RawMcpConfig) {
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
        oauth:
          cloned.oauth && typeof cloned.oauth === "object"
            ? {
                authUrl: cloned.oauth.authUrl,
                tokenUrl: cloned.oauth.tokenUrl,
                clientId: cloned.oauth.clientId,
                clientSecret: cloned.oauth.clientSecret,
                scopes: cloned.oauth.scopes,
                grantType: cloned.oauth.grantType || "authorization_code",
                responseType: cloned.oauth.responseType || "code",
              }
            : undefined,
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
        loginUrl:
          typeof cloned.loginUrl === "string" ? cloned.loginUrl : undefined,
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
    oauth:
      cloned.oauth && typeof cloned.oauth === "object"
        ? {
            authUrl: cloned.oauth.authUrl,
            tokenUrl: cloned.oauth.tokenUrl,
            clientId: cloned.oauth.clientId,
            clientSecret: cloned.oauth.clientSecret,
            scopes: cloned.oauth.scopes,
            grantType: cloned.oauth.grantType || "authorization_code",
            responseType: cloned.oauth.responseType || "code",
          }
        : undefined,
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
    loginUrl: typeof cloned.loginUrl === "string" ? cloned.loginUrl : undefined,
  };
}

function cloneConfig(config: any) {
  return JSON.parse(JSON.stringify(config));
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
  normalized["X-Mcp-Id"] = mcpId; // Add MCP identifier header
  return normalized;
}
