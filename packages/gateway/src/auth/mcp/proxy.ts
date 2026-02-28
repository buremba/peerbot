import { createLogger, verifyWorkerToken } from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import type { IMessageQueue } from "../../infrastructure/queue";
import { requiresToolApproval } from "../../permissions/approval-policy";
import type { GrantStore } from "../../permissions/grant-store";
import { GenericOAuth2Client } from "../oauth/generic-client";
import type { McpConfigService } from "./config-service";
import type { McpCredentialStore } from "./credential-store";
import type { McpInputStore } from "./input-store";
import { substituteObject, substituteString } from "./string-substitution";
import type { McpTool, McpToolCache } from "./tool-cache";

const logger = createLogger("mcp-proxy");

interface JsonRpcResponse {
  jsonrpc: string;
  id: unknown;
  result?: { tools?: McpTool[]; content?: unknown[]; isError?: boolean };
  error?: { code: number; message: string };
}

interface ResolvedMcp {
  httpServer: any;
  credentials: { accessToken: string; tokenType?: string } | null;
  inputValues: Record<string, string>;
  agentId: string;
}

export class McpProxy {
  private readonly oauth2Client = new GenericOAuth2Client();
  private readonly SESSION_TTL_SECONDS = 30 * 60; // 30 minutes
  private readonly redisClient: any;
  private app: Hono;
  private toolCache?: McpToolCache;
  private readonly refreshLocks: Map<string, Promise<any>> = new Map();

  constructor(
    private readonly configService: McpConfigService,
    private readonly credentialStore: McpCredentialStore,
    private readonly inputStore: McpInputStore,
    queue: IMessageQueue,
    toolCache?: McpToolCache,
    private readonly grantStore?: GrantStore
  ) {
    this.redisClient = queue.getRedisClient();
    this.toolCache = toolCache;
    this.app = new Hono();
    this.setupRoutes();
    logger.info("MCP proxy initialized with Redis session storage", {
      ttlMinutes: this.SESSION_TTL_SECONDS / 60,
    });
  }

  /**
   * Get the Hono app
   */
  getApp(): Hono {
    return this.app;
  }

  /**
   * Check if this request is an MCP proxy request (has X-Mcp-Id header)
   * Used by gateway to determine if root path requests should be handled by MCP proxy
   */
  isMcpRequest(c: Context): boolean {
    return !!c.req.header("x-mcp-id");
  }

  /**
   * Fetch tools for a specific MCP server.
   * Used by session-context handler to include tool lists in the response.
   */
  async fetchToolsForMcp(
    mcpId: string,
    agentId: string,
    tokenData: any
  ): Promise<McpTool[]> {
    // Check cache first
    if (this.toolCache) {
      const cached = await this.toolCache.get(mcpId, agentId);
      if (cached) return cached;
    }

    // Resolve MCP server
    const resolved = await this.resolveMcpServer(mcpId, tokenData);
    if (!resolved) return [];

    try {
      const jsonRpcBody = JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
        id: 1,
      });

      const response = await this.sendUpstreamRequest(
        resolved.httpServer,
        resolved.credentials,
        resolved.inputValues,
        resolved.agentId,
        mcpId,
        "POST",
        jsonRpcBody
      );

      const data = (await response.json()) as JsonRpcResponse;
      const tools: McpTool[] = data?.result?.tools || [];

      // Cache result
      if (this.toolCache && tools.length > 0) {
        await this.toolCache.set(mcpId, tools, agentId);
      }

      return tools;
    } catch (error) {
      logger.error("Failed to fetch tools for MCP", { mcpId, error });
      return [];
    }
  }

  private setupRoutes() {
    // REST API endpoints for curl-based tool access (registered BEFORE catch-all)
    this.app.get("/tools", (c) => this.handleListAllTools(c));
    this.app.get("/:mcpId/tools", (c) => this.handleListTools(c));
    this.app.post("/:mcpId/tools/:toolName", (c) => this.handleCallTool(c));

    // Legacy endpoints (if needed for other MCP transports)
    this.app.all("/register", (c) => this.handleProxyRequest(c));
    this.app.all("/message", (c) => this.handleProxyRequest(c));

    // Path-based routes (for SSE or other transports)
    this.app.all("/:mcpId", (c) => this.handleProxyRequest(c));
    this.app.all("/:mcpId/*", (c) => this.handleProxyRequest(c));
  }

  // ===========================================================================
  // REST API handlers
  // ===========================================================================

  /**
   * GET /mcp/:mcpId/tools - List tools for a specific MCP server
   */
  private async handleListTools(c: Context): Promise<Response> {
    const mcpId = c.req.param("mcpId");
    const auth = this.authenticateRequest(c);
    if (!auth) return c.json({ error: "Invalid authentication token" }, 401);

    const resolved = await this.resolveMcpServer(mcpId, auth.tokenData);
    if (!resolved) {
      return c.json({ error: `MCP server '${mcpId}' not found` }, 404);
    }

    // Check cache
    if (this.toolCache) {
      const cached = await this.toolCache.get(mcpId, resolved.agentId);
      if (cached) return c.json({ tools: cached });
    }

    try {
      const jsonRpcBody = JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
        id: 1,
      });

      const response = await this.sendUpstreamRequest(
        resolved.httpServer,
        resolved.credentials,
        resolved.inputValues,
        resolved.agentId,
        mcpId,
        "POST",
        jsonRpcBody
      );

      const data = (await response.json()) as JsonRpcResponse;
      if (data?.error) {
        logger.error("Upstream returned JSON-RPC error", {
          mcpId,
          error: data.error,
        });
        return c.json({ error: data.error.message || "Upstream error" }, 502);
      }

      const tools: McpTool[] = data?.result?.tools || [];

      // Cache result
      if (this.toolCache && tools.length > 0) {
        await this.toolCache.set(mcpId, tools, resolved.agentId);
      }

      return c.json({ tools });
    } catch (error) {
      logger.error("Failed to list tools", { mcpId, error });
      return c.json(
        {
          error: `Failed to connect to MCP '${mcpId}': ${error instanceof Error ? error.message : "Unknown error"}`,
        },
        502
      );
    }
  }

  /**
   * POST /mcp/:mcpId/tools/:toolName - Call a tool on a specific MCP server
   */
  private async handleCallTool(c: Context): Promise<Response> {
    const mcpId = c.req.param("mcpId");
    const toolName = c.req.param("toolName");
    const auth = this.authenticateRequest(c);
    if (!auth) return c.json({ error: "Invalid authentication token" }, 401);

    const resolved = await this.resolveMcpServer(mcpId, auth.tokenData);
    if (!resolved) {
      return c.json({ error: `MCP server '${mcpId}' not found` }, 404);
    }

    // Check tool approval based on annotations and grants
    if (this.grantStore) {
      const annotations = await this.getToolAnnotations(
        mcpId,
        toolName,
        resolved.agentId,
        auth.tokenData
      );
      if (requiresToolApproval(annotations)) {
        const pattern = `/mcp/${mcpId}/tools/${toolName}`;
        const hasGrant = await this.grantStore.hasGrant(
          resolved.agentId,
          pattern
        );
        if (!hasGrant) {
          logger.info("Tool call blocked: requires approval", {
            agentId: resolved.agentId,
            mcpId,
            toolName,
            pattern,
          });
          return c.json(
            {
              content: [
                {
                  type: "text",
                  text: `Tool call requires approval. Grant access via settings page for: ${mcpId} → ${toolName}`,
                },
              ],
              isError: true,
            },
            403
          );
        }
      }
    }

    let toolArguments: Record<string, unknown> = {};
    try {
      const body = await c.req.text();
      if (body) {
        toolArguments = JSON.parse(body);
      }
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    try {
      const jsonRpcBody = JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: toolName, arguments: toolArguments },
        id: 1,
      });

      const response = await this.sendUpstreamRequest(
        resolved.httpServer,
        resolved.credentials,
        resolved.inputValues,
        resolved.agentId,
        mcpId,
        "POST",
        jsonRpcBody
      );

      const data = (await response.json()) as JsonRpcResponse;
      if (data?.error) {
        logger.error("Upstream returned JSON-RPC error on tool call", {
          mcpId,
          toolName,
          error: data.error,
        });
        return c.json(
          {
            content: [],
            isError: true,
            error: data.error.message || "Upstream error",
          },
          502
        );
      }

      const result = data?.result || {};
      return c.json({
        content: result.content || [],
        isError: result.isError || false,
      });
    } catch (error) {
      logger.error("Failed to call tool", { mcpId, toolName, error });
      return c.json(
        {
          content: [],
          isError: true,
          error: `Failed to connect to MCP '${mcpId}': ${error instanceof Error ? error.message : "Unknown error"}`,
        },
        502
      );
    }
  }

  /**
   * GET /mcp/tools - List all tools across all MCP servers
   */
  private async handleListAllTools(c: Context): Promise<Response> {
    const auth = this.authenticateRequest(c);
    if (!auth) return c.json({ error: "Invalid authentication token" }, 401);

    const agentId = auth.tokenData.agentId || auth.tokenData.userId;

    const allHttpServers = await this.configService.getAllHttpServers(
      agentId,
      auth.tokenData.deploymentName
    );
    const allMcpIds = Array.from(allHttpServers.keys());

    const mcpServers: Record<string, { tools: McpTool[] }> = {};

    // Fetch tools in parallel, tolerate failures
    const results = await Promise.allSettled(
      allMcpIds.map(async (mcpId) => {
        const tools = await this.fetchToolsForMcp(
          mcpId,
          agentId,
          auth.tokenData
        );
        return { mcpId, tools };
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value.tools.length > 0) {
        mcpServers[result.value.mcpId] = { tools: result.value.tools };
      }
    }

    return c.json({ mcpServers });
  }

  // ===========================================================================
  // Shared auth/resolve helpers
  // ===========================================================================

  private authenticateRequest(
    c: Context
  ): { tokenData: any; token: string } | null {
    const sessionToken = this.extractSessionToken(c);
    if (!sessionToken) return null;

    const tokenData = verifyWorkerToken(sessionToken);
    if (!tokenData) return null;

    return { tokenData, token: sessionToken };
  }

  /**
   * Resolve an MCP server by ID, including auth credential resolution.
   * Returns null if the MCP is not found or requires auth that is missing
   * (in that case for REST endpoints the caller returns an HTTP error).
   */
  private async resolveMcpServer(
    mcpId: string,
    tokenData: any
  ): Promise<ResolvedMcp | null> {
    const agentId = tokenData.agentId || tokenData.userId;
    const httpServer = await this.configService.getHttpServer(
      mcpId,
      agentId,
      tokenData.deploymentName
    );
    if (!httpServer) return null;

    let credentials = null;
    let inputValues: Record<string, string> = {};

    // Check OAuth (static or discovered)
    const hasOAuth = !!httpServer.oauth;
    const discoveredOAuth = await this.configService.getDiscoveredOAuth(mcpId);
    const hasDiscoveredOAuth = !!discoveredOAuth;

    if (hasOAuth || hasDiscoveredOAuth) {
      credentials = await this.credentialStore.getCredentials(agentId, mcpId);
      if (!credentials?.accessToken) return null;

      // Refresh expired token
      if (credentials.expiresAt && credentials.expiresAt <= Date.now()) {
        if (!credentials.refreshToken) return null;

        try {
          credentials = await this.refreshCredentials(
            httpServer,
            discoveredOAuth,
            credentials.refreshToken,
            agentId,
            mcpId
          );
        } catch {
          return null;
        }
      }
    }

    // Load input values
    if (httpServer.inputs && httpServer.inputs.length > 0) {
      const inputs = await this.inputStore.getInputs(agentId, mcpId);
      if (!inputs) return null;
      inputValues = inputs;
    }

    return { httpServer, credentials, inputValues, agentId };
  }

  /**
   * Refresh credentials with deduplication to prevent concurrent refresh token exhaustion.
   * If a refresh is already in progress for the same agent+mcp, waits for that result.
   */
  private async refreshCredentials(
    httpServer: any,
    discoveredOAuth: any,
    refreshToken: string,
    agentId: string,
    mcpId: string
  ): Promise<{ accessToken: string; tokenType?: string }> {
    const lockKey = `${agentId}:${mcpId}`;
    const existing = this.refreshLocks.get(lockKey);
    if (existing) {
      logger.info("Waiting for in-flight token refresh", { agentId, mcpId });
      return existing;
    }

    const refreshPromise = this.doRefreshCredentials(
      httpServer,
      discoveredOAuth,
      refreshToken,
      agentId,
      mcpId
    ).finally(() => {
      this.refreshLocks.delete(lockKey);
    });

    this.refreshLocks.set(lockKey, refreshPromise);
    return refreshPromise;
  }

  private async doRefreshCredentials(
    httpServer: any,
    discoveredOAuth: any,
    refreshToken: string,
    agentId: string,
    mcpId: string
  ): Promise<{ accessToken: string; tokenType?: string }> {
    let oauthConfig = httpServer.oauth;

    if (!oauthConfig && discoveredOAuth?.metadata) {
      const discoveryService = this.configService.getDiscoveryService();
      if (!discoveryService)
        throw new Error("OAuth discovery service not available");

      const clientCredentials =
        await discoveryService.getOrCreateClientCredentials(
          mcpId,
          discoveredOAuth.metadata
        );
      if (!clientCredentials?.client_id) {
        throw new Error("Failed to get client credentials for refresh");
      }

      oauthConfig = {
        authUrl: discoveredOAuth.metadata.authorization_endpoint,
        tokenUrl: discoveredOAuth.metadata.token_endpoint,
        clientId: clientCredentials.client_id,
        clientSecret: clientCredentials.client_secret || "",
        scopes: discoveredOAuth.metadata.scopes_supported || [],
        grantType: "authorization_code",
        responseType: "code",
        tokenEndpointAuthMethod: clientCredentials.token_endpoint_auth_method,
      };
    }

    if (!oauthConfig) throw new Error("No OAuth config available for refresh");

    const refreshedCredentials = await this.oauth2Client.refreshToken(
      refreshToken,
      oauthConfig
    );

    await this.credentialStore.setCredentials(
      agentId,
      mcpId,
      refreshedCredentials
    );
    logger.info("Successfully refreshed MCP access token", { agentId, mcpId });
    return refreshedCredentials;
  }

  // ===========================================================================
  // Upstream request helpers
  // ===========================================================================

  private buildUpstreamHeaders(
    credentials: { accessToken: string; tokenType?: string } | null,
    inputValues: Record<string, string>,
    sessionId: string | null
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };

    if (sessionId) {
      headers["Mcp-Session-Id"] = sessionId;
    }

    if (credentials?.accessToken) {
      headers.Authorization = `Bearer ${credentials.accessToken}`;
    }

    // Apply input substitution to headers
    if (Object.keys(inputValues).length > 0) {
      for (const [key, value] of Object.entries(headers)) {
        headers[key] = substituteString(value, inputValues);
      }
    }

    return headers;
  }

  /**
   * Send a request to upstream MCP server and return the raw Response.
   * Used by REST endpoints that need to read the full response body.
   */
  private async sendUpstreamRequest(
    httpServer: any,
    credentials: { accessToken: string; tokenType?: string } | null,
    inputValues: Record<string, string>,
    agentId: string,
    mcpId: string,
    method: string,
    body?: string
  ): Promise<Response> {
    const sessionKey = `mcp:session:${agentId}:${mcpId}`;
    const sessionId = await this.getSession(sessionKey);

    const headers = this.buildUpstreamHeaders(
      credentials,
      inputValues,
      sessionId
    );

    // Apply input substitution to body
    let finalBody = body;
    if (finalBody && Object.keys(inputValues).length > 0) {
      try {
        const bodyJson = JSON.parse(finalBody);
        const substitutedBody = substituteObject(bodyJson, inputValues);
        finalBody = JSON.stringify(substitutedBody);
      } catch {
        finalBody = substituteString(finalBody, inputValues);
      }
    }

    const response = await fetch(httpServer.upstreamUrl, {
      method,
      headers,
      body: finalBody || undefined,
    });

    // Track session
    const newSessionId = response.headers.get("Mcp-Session-Id");
    if (newSessionId) {
      await this.setSession(sessionKey, newSessionId);
    }

    return response;
  }

  // ===========================================================================
  // Original proxy handler (streaming, used by MCP SDK clients)
  // ===========================================================================

  private async handleProxyRequest(c: Context): Promise<Response> {
    const mcpId = c.req.param("mcpId") || c.req.header("x-mcp-id");
    const sessionToken = this.extractSessionToken(c);

    logger.info("Handling MCP proxy request", {
      method: c.req.method,
      path: c.req.path,
      mcpId,
      hasSessionToken: !!sessionToken,
    });

    if (!mcpId) {
      return this.sendJsonRpcError(c, -32600, "Missing MCP ID");
    }

    if (!sessionToken) {
      return this.sendJsonRpcError(c, -32600, "Missing authentication token");
    }

    const tokenData = verifyWorkerToken(sessionToken);
    if (!tokenData) {
      return this.sendJsonRpcError(c, -32600, "Invalid authentication token");
    }

    const agentId = tokenData.agentId || tokenData.userId;
    const httpServer = await this.configService.getHttpServer(
      mcpId!,
      agentId,
      tokenData.deploymentName
    );

    if (!httpServer) {
      return this.sendJsonRpcError(
        c,
        -32601,
        `MCP server '${mcpId}' not found`
      );
    }

    // Check authentication - OAuth or inputs
    let credentials = null;
    let inputValues = null;
    const hasOAuth = !!httpServer.oauth;
    const discoveredOAuth = await this.configService.getDiscoveredOAuth(mcpId!);
    const hasDiscoveredOAuth = !!discoveredOAuth;

    if (hasOAuth || hasDiscoveredOAuth) {
      credentials = await this.credentialStore.getCredentials(agentId, mcpId!);

      if (!credentials || !credentials.accessToken) {
        logger.info("MCP OAuth credentials missing", { agentId, mcpId });
        return this.sendJsonRpcError(
          c,
          -32002,
          `MCP '${mcpId}' requires authentication. Please authenticate via the Slack app home tab.`
        );
      }

      if (credentials.expiresAt && credentials.expiresAt <= Date.now()) {
        logger.info("MCP access token expired, attempting refresh", {
          agentId,
          mcpId,
          hasRefreshToken: !!credentials.refreshToken,
        });

        if (credentials.refreshToken) {
          try {
            credentials = await this.refreshCredentials(
              httpServer,
              discoveredOAuth,
              credentials.refreshToken,
              agentId,
              mcpId!
            );
          } catch (error) {
            logger.error("Failed to refresh MCP access token", {
              error,
              errorMessage:
                error instanceof Error ? error.message : String(error),
              errorStack: error instanceof Error ? error.stack : undefined,
              agentId,
              mcpId,
            });
            return this.sendJsonRpcError(
              c,
              -32002,
              `MCP '${mcpId}' authentication expired. Please re-authenticate via the Slack app home tab.`
            );
          }
        } else {
          logger.warn("MCP credentials expired with no refresh token", {
            agentId,
            mcpId,
          });
          return this.sendJsonRpcError(
            c,
            -32002,
            `MCP '${mcpId}' authentication expired. Please re-authenticate via the Slack app home tab.`
          );
        }
      }
    }

    // Load input values if MCP uses inputs
    if (httpServer.inputs && httpServer.inputs.length > 0) {
      inputValues = await this.inputStore.getInputs(agentId, mcpId!);

      if (!inputValues) {
        logger.info("MCP input values missing", { agentId, mcpId });
        return this.sendJsonRpcError(
          c,
          -32002,
          `MCP '${mcpId}' requires configuration. Please configure via the Slack app home tab.`
        );
      }
    }

    try {
      return await this.forwardRequestWithProtocolTranslation(
        c,
        httpServer,
        credentials,
        inputValues || {},
        agentId,
        mcpId!
      );
    } catch (error) {
      logger.error("Failed to proxy MCP request", { error, mcpId });
      return this.sendJsonRpcError(
        c,
        -32603,
        `Failed to connect to MCP '${mcpId}': ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  /**
   * Send a JSON-RPC 2.0 error response with 200 status code
   */
  private sendJsonRpcError(
    c: Context,
    code: number,
    message: string,
    id: any = null
  ): Response {
    return c.json(
      {
        jsonrpc: "2.0",
        id,
        error: { code, message },
      },
      200
    );
  }

  private extractSessionToken(c: Context): string | null {
    const authHeader = c.req.header("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      return authHeader.substring(7);
    }

    const tokenFromQuery = c.req.query("workerToken");
    if (typeof tokenFromQuery === "string") {
      return tokenFromQuery;
    }

    return null;
  }

  /**
   * Forward request to upstream with streaming response (used by MCP SDK clients)
   */
  private async forwardRequestWithProtocolTranslation(
    c: Context,
    httpServer: any,
    credentials: { accessToken: string; tokenType?: string } | null,
    inputValues: Record<string, string>,
    agentId: string,
    mcpId: string
  ): Promise<Response> {
    const sessionKey = `mcp:session:${agentId}:${mcpId}`;
    const sessionId = await this.getSession(sessionKey);

    let bodyText = await this.getRequestBodyAsText(c);

    logger.info("Proxying MCP request", {
      mcpId,
      agentId,
      method: c.req.method,
      hasSession: !!sessionId,
      bodyLength: bodyText.length,
      hasInputValues: Object.keys(inputValues).length > 0,
    });

    const headers = this.buildUpstreamHeaders(
      credentials,
      inputValues,
      sessionId
    );

    // Apply input substitution to body
    if (Object.keys(inputValues).length > 0 && bodyText) {
      try {
        const bodyJson = JSON.parse(bodyText);
        const substitutedBody = substituteObject(bodyJson, inputValues);
        bodyText = JSON.stringify(substitutedBody);
        logger.debug("Applied input substitution to request body", {
          mcpId,
          agentId,
        });
      } catch {
        bodyText = substituteString(bodyText, inputValues);
      }
    }

    const response = await fetch(httpServer.upstreamUrl, {
      method: c.req.method,
      headers,
      body: bodyText || undefined,
    });

    const newSessionId = response.headers.get("Mcp-Session-Id");
    if (newSessionId) {
      await this.setSession(sessionKey, newSessionId);
      logger.debug("Stored MCP session ID", {
        mcpId,
        agentId,
        sessionId: newSessionId,
      });
    }

    const responseHeaders = new Headers();
    const contentType = response.headers.get("content-type");
    if (contentType) {
      responseHeaders.set("Content-Type", contentType);
    }
    if (newSessionId) {
      responseHeaders.set("Mcp-Session-Id", newSessionId);
    }

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  }

  private async getRequestBodyAsText(c: Context): Promise<string> {
    if (c.req.method === "GET" || c.req.method === "HEAD") {
      return "";
    }

    try {
      return await c.req.text();
    } catch {
      return "";
    }
  }

  /**
   * Look up tool annotations from the cache.
   * Falls back to fetching tools if not cached.
   */
  private async getToolAnnotations(
    mcpId: string,
    toolName: string,
    agentId: string,
    tokenData: any
  ): Promise<McpTool["annotations"] | undefined> {
    // Check cache first
    let tools: McpTool[] | null = null;
    if (this.toolCache) {
      tools = await this.toolCache.get(mcpId, agentId);
    }

    // Fetch if not cached
    if (!tools) {
      tools = await this.fetchToolsForMcp(mcpId, agentId, tokenData);
    }

    const tool = tools.find((t) => t.name === toolName);
    return tool?.annotations;
  }

  private async getSession(key: string): Promise<string | null> {
    try {
      const sessionId = await this.redisClient.get(key);
      if (sessionId) {
        await this.redisClient.expire(key, this.SESSION_TTL_SECONDS);
      }
      return sessionId;
    } catch (error) {
      logger.error("Failed to get MCP session from Redis", { key, error });
      return null;
    }
  }

  private async setSession(key: string, sessionId: string): Promise<void> {
    try {
      await this.redisClient.set(
        key,
        sessionId,
        "EX",
        this.SESSION_TTL_SECONDS
      );
    } catch (error) {
      logger.error("Failed to store MCP session in Redis", { key, error });
    }
  }
}
