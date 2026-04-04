import dns from "node:dns/promises";
import { createLogger, verifyWorkerToken } from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import type { IMessageQueue } from "../../infrastructure/queue";
import { requiresToolApproval } from "../../permissions/approval-policy";
import type { GrantStore } from "../../permissions/grant-store";
import {
  getStoredCredential,
  refreshCredential,
  tryCompletePendingDeviceAuth,
} from "../../routes/internal/device-auth";
import type { CachedMcpServer, McpTool, McpToolCache } from "./tool-cache";

const logger = createLogger("mcp-proxy");

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

/**
 * Check whether a resolved IP address belongs to a reserved/internal range.
 */
function isReservedIp(ip: string): boolean {
  // IPv6 loopback
  if (ip === "::1") return true;

  // IPv6 unique local (fc00::/7)
  if (/^f[cd]/i.test(ip)) return true;

  // IPv4
  const parts = ip.split(".").map(Number);
  if (parts.length === 4) {
    const [a, b] = parts as [number, number, number, number];
    // 127.0.0.0/8
    if (a === 127) return true;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) return true;
  }

  return false;
}

/**
 * Resolve a URL's hostname and check whether it points to an internal/reserved network.
 */
async function isInternalUrl(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    // Check if hostname is already an IP literal
    if (isReservedIp(hostname)) return true;

    // Resolve hostname to IP addresses
    const addresses = await dns.resolve4(hostname).catch(() => [] as string[]);
    const addresses6 = await dns.resolve6(hostname).catch(() => [] as string[]);

    for (const addr of [...addresses, ...addresses6]) {
      if (isReservedIp(addr)) return true;
    }

    return false;
  } catch {
    // If URL parsing fails, block it
    return true;
  }
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: unknown;
  result?: {
    tools?: McpTool[];
    content?: unknown[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

interface HttpMcpServerConfig {
  id: string;
  upstreamUrl: string;
  oauth?: unknown;
  inputs?: unknown[];
  headers?: Record<string, string>;
  loginUrl?: string;
  resource?: string;
}

interface McpConfigSource {
  getHttpServer(
    id: string,
    agentId?: string
  ): Promise<HttpMcpServerConfig | undefined>;
  getAllHttpServers(
    agentId?: string
  ): Promise<Map<string, HttpMcpServerConfig>>;
}

function authenticateRequest(
  c: Context
): { tokenData: any; token: string } | null {
  const sessionToken = extractSessionToken(c);
  if (!sessionToken) return null;

  const tokenData = verifyWorkerToken(sessionToken);
  if (!tokenData) return null;

  return { tokenData, token: sessionToken };
}

function extractSessionToken(c: Context): string | null {
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

export class McpProxy {
  private readonly SESSION_TTL_SECONDS = 30 * 60; // 30 minutes
  private readonly redisClient: any;
  private app: Hono;
  private toolCache?: McpToolCache;

  constructor(
    private readonly configService: McpConfigSource,
    queue: IMessageQueue,
    toolCache?: McpToolCache,
    private readonly grantStore?: GrantStore
  ) {
    this.redisClient = queue.getRedisClient();
    this.toolCache = toolCache;
    this.app = new Hono();
    this.setupRoutes();
    logger.debug("MCP proxy initialized");
  }

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
   * Fetch tools and instructions for a specific MCP server.
   * Performs MCP initialize handshake first to capture server instructions,
   * then fetches tool list.
   */
  async fetchToolsForMcp(
    mcpId: string,
    agentId: string,
    tokenData: any
  ): Promise<{ tools: McpTool[]; instructions?: string }> {
    if (this.toolCache) {
      const cached = await this.toolCache.getServerInfo(mcpId, agentId);
      if (cached) return cached;
    }

    const httpServer = await this.configService.getHttpServer(mcpId, agentId);
    if (!httpServer) {
      return { tools: [] };
    }

    const userId = tokenData?.userId;

    try {
      // Clear any stale session before fresh tool discovery
      const sessionKey = `mcp:session:${agentId}:${mcpId}`;
      await this.redisClient.del(sessionKey).catch(() => {
        /* noop */
      });

      // Step 1: Send initialize to capture server instructions
      let instructions: string | undefined;
      try {
        const initBody = JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "lobu-gateway", version: "1.0.0" },
          },
          id: 0,
        });

        const initResponse = await this.sendUpstreamRequest(
          httpServer,
          agentId,
          mcpId,
          "POST",
          initBody,
          userId
        );

        const initData = (await initResponse.json()) as {
          result?: { instructions?: string };
          error?: { code: number; message: string };
        };

        if (initData?.result?.instructions) {
          instructions = initData.result.instructions;
          logger.info("Captured MCP server instructions", {
            mcpId,
            length: instructions.length,
          });
        }

        // Step 2: Send initialized notification (required by MCP spec)
        const notifyBody = JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        });
        await this.sendUpstreamRequest(
          httpServer,
          agentId,
          mcpId,
          "POST",
          notifyBody,
          userId
        ).catch(() => {
          /* noop */
        });
      } catch (initError) {
        logger.warn("MCP initialize failed (continuing with tools/list)", {
          mcpId,
          error:
            initError instanceof Error ? initError.message : String(initError),
        });
      }

      // Step 3: Fetch tools list
      const jsonRpcBody = JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
        id: 1,
      });

      const response = await this.sendUpstreamRequest(
        httpServer,
        agentId,
        mcpId,
        "POST",
        jsonRpcBody,
        userId
      );

      const data = (await response.json()) as JsonRpcResponse;
      const tools: McpTool[] = data?.result?.tools || [];

      const serverInfo: CachedMcpServer = { tools, instructions };
      if (this.toolCache && tools.length > 0) {
        await this.toolCache.setServerInfo(mcpId, serverInfo, agentId);
      }

      return serverInfo;
    } catch (error) {
      logger.warn("Failed to fetch tools for MCP, retrying once", {
        mcpId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Retry once after a short delay (upstream may still be starting)
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const retryBody = JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
          id: 1,
        });
        const retryResponse = await this.sendUpstreamRequest(
          httpServer,
          agentId,
          mcpId,
          "POST",
          retryBody,
          userId
        );
        const retryData = (await retryResponse.json()) as JsonRpcResponse;
        const retryTools: McpTool[] = retryData?.result?.tools || [];
        if (retryTools.length > 0) {
          const serverInfo: CachedMcpServer = { tools: retryTools };
          if (this.toolCache) {
            await this.toolCache.setServerInfo(mcpId, serverInfo, agentId);
          }
          logger.info("Retry succeeded for MCP tool fetch", {
            mcpId,
            toolCount: retryTools.length,
          });
          return serverInfo;
        }
      } catch (retryError) {
        logger.error("Retry also failed for MCP tool fetch", {
          mcpId,
          error:
            retryError instanceof Error
              ? retryError.message
              : String(retryError),
        });
      }
      return { tools: [] };
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

  private async handleListTools(c: Context): Promise<Response> {
    const mcpId = c.req.param("mcpId");
    if (!mcpId) return c.json({ error: "Missing MCP server id" }, 400);
    const auth = authenticateRequest(c);
    if (!auth) return c.json({ error: "Invalid authentication token" }, 401);

    const agentId = auth.tokenData.agentId || auth.tokenData.userId;
    const requesterUserId = auth.tokenData.userId;
    if (!agentId || !requesterUserId) {
      return c.json({ error: "Invalid authentication token" }, 401);
    }
    const httpServer = await this.configService.getHttpServer(mcpId, agentId);
    if (!httpServer) {
      return c.json({ error: `MCP server '${mcpId}' not found` }, 404);
    }

    // Check cache
    if (this.toolCache) {
      const cached = await this.toolCache.get(mcpId, agentId);
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
        httpServer,
        agentId,
        mcpId,
        "POST",
        jsonRpcBody,
        requesterUserId
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
        await this.toolCache.set(mcpId, tools, agentId);
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

  private async handleCallTool(c: Context): Promise<Response> {
    const mcpId = c.req.param("mcpId");
    const toolName = c.req.param("toolName");
    if (!mcpId || !toolName) {
      return c.json({ error: "Missing MCP server id or tool name" }, 400);
    }
    const auth = authenticateRequest(c);
    if (!auth) return c.json({ error: "Invalid authentication token" }, 401);

    const agentId = auth.tokenData.agentId || auth.tokenData.userId;
    const requesterUserId = auth.tokenData.userId;
    if (!agentId || !requesterUserId) {
      return c.json({ error: "Invalid authentication token" }, 401);
    }
    const httpServer = await this.configService.getHttpServer(mcpId, agentId);
    if (!httpServer) {
      return c.json({ error: `MCP server '${mcpId}' not found` }, 404);
    }

    // Check tool approval based on annotations and grants.
    if (this.grantStore) {
      const { found, annotations } = await this.getToolAnnotations(
        mcpId,
        toolName,
        agentId,
        auth.tokenData
      );
      if (found && requiresToolApproval(annotations)) {
        const pattern = `/mcp/${mcpId}/tools/${toolName}`;
        const hasGrant = await this.grantStore.hasGrant(agentId, pattern);
        if (!hasGrant) {
          logger.info("Tool call blocked: requires approval", {
            agentId,
            mcpId,
            toolName,
            pattern,
          });
          return c.json(
            {
              content: [
                {
                  type: "text",
                  text: `Tool call requires approval. Request access approval in chat for: ${mcpId} → ${toolName}`,
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
        if (body.length > MAX_BODY_SIZE) {
          return c.json({ error: "Request body too large" }, 413);
        }
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

      let response = await this.sendUpstreamRequest(
        httpServer,
        agentId,
        mcpId,
        "POST",
        jsonRpcBody,
        requesterUserId
      );

      let data = (await response.json()) as JsonRpcResponse;

      // Re-initialize session and retry on "Server not initialized"
      if (data?.error && /not initialized/i.test(data.error.message || "")) {
        logger.info("MCP session expired, re-initializing before retry", {
          mcpId,
          toolName,
        });
        await this.reinitializeSession(
          httpServer,
          agentId,
          mcpId,
          requesterUserId
        );

        response = await this.sendUpstreamRequest(
          httpServer,
          agentId,
          mcpId,
          "POST",
          jsonRpcBody,
          requesterUserId
        );
        data = (await response.json()) as JsonRpcResponse;
      }

      if (data?.error) {
        const errorMsg =
          data.error.message ||
          (typeof data.error === "string" ? data.error : "Upstream error");
        logger.error("Upstream returned JSON-RPC error on tool call", {
          mcpId,
          toolName,
          error: data.error,
        });

        // Detect auth errors — auto-start device-code auth flow
        if (/unauthorized|unauthenticated|forbidden/i.test(errorMsg)) {
          const autoAuthResult = await this.tryAutoDeviceAuth(
            mcpId,
            agentId,
            requesterUserId
          );
          if (autoAuthResult) {
            return c.json(
              {
                content: [
                  {
                    type: "text",
                    text: autoAuthResult,
                  },
                ],
                isError: true,
              },
              200
            );
          }
          return c.json(
            {
              content: [
                {
                  type: "text",
                  text: `Authentication required for ${mcpId}. Call owletto_login to authenticate.`,
                },
              ],
              isError: true,
            },
            200
          );
        }

        return c.json(
          {
            content: [],
            isError: true,
            error: errorMsg,
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

  private async handleListAllTools(c: Context): Promise<Response> {
    const auth = authenticateRequest(c);
    if (!auth) return c.json({ error: "Invalid authentication token" }, 401);

    const agentId = auth.tokenData.agentId || auth.tokenData.userId;

    const allHttpServers = await this.configService.getAllHttpServers(agentId);
    const allMcpIds = Array.from(allHttpServers.keys());

    const mcpServers: Record<string, { tools: McpTool[] }> = {};

    // Fetch tools in parallel, tolerate failures
    const results = await Promise.allSettled(
      allMcpIds.map(async (mcpId) => {
        const { tools } = await this.fetchToolsForMcp(
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

  private async handleProxyRequest(c: Context): Promise<Response> {
    const mcpId = c.req.param("mcpId") || c.req.header("x-mcp-id");
    const sessionToken = extractSessionToken(c);

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
    const httpServer = await this.configService.getHttpServer(mcpId!, agentId);

    if (!httpServer) {
      return this.sendJsonRpcError(
        c,
        -32601,
        `MCP server '${mcpId}' not found`
      );
    }

    try {
      return await this.forwardRequest(
        c,
        httpServer,
        agentId,
        mcpId!,
        tokenData.userId
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

  private async getToolAnnotations(
    mcpId: string,
    toolName: string,
    agentId: string,
    tokenData: any
  ): Promise<{ found: boolean; annotations?: McpTool["annotations"] }> {
    let tools: McpTool[] | null = null;
    if (this.toolCache) {
      tools = await this.toolCache.get(mcpId, agentId);
    }

    if (!tools) {
      const result = await this.fetchToolsForMcp(mcpId, agentId, tokenData);
      tools = result.tools;
    }

    if (tools.length === 0) {
      return { found: false };
    }

    const tool = tools.find((t) => t.name === toolName);
    return { found: true, annotations: tool?.annotations };
  }

  private buildUpstreamHeaders(
    sessionId: string | null,
    configHeaders?: Record<string, string>,
    credentialToken?: string
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    // Merge custom headers from server config (e.g. static auth tokens)
    if (configHeaders) {
      for (const [key, value] of Object.entries(configHeaders)) {
        headers[key] = value;
      }
    }

    // Per-user credential takes precedence over config headers for Authorization
    if (credentialToken) {
      headers.Authorization = `Bearer ${credentialToken}`;
    }

    if (sessionId) {
      headers["Mcp-Session-Id"] = sessionId;
    }

    return headers;
  }

  private async resolveCredentialToken(
    agentId: string,
    userId: string,
    mcpId: string
  ): Promise<string | null> {
    const credential = await getStoredCredential(
      this.redisClient,
      agentId,
      userId,
      mcpId
    );
    if (!credential) {
      // No stored credential — check if there's a pending device-auth to complete
      return tryCompletePendingDeviceAuth(
        this.redisClient,
        agentId,
        userId,
        mcpId
      );
    }

    // Check if token is still valid (5 minute buffer)
    if (credential.expiresAt > Date.now() + 5 * 60 * 1000) {
      return credential.accessToken;
    }

    // Token expired or expiring soon — refresh
    const refreshed = await refreshCredential(
      this.redisClient,
      agentId,
      userId,
      mcpId,
      credential
    );
    return refreshed?.accessToken ?? null;
  }

  private async sendUpstreamRequest(
    httpServer: HttpMcpServerConfig,
    agentId: string,
    mcpId: string,
    method: string,
    body?: string,
    userId?: string
  ): Promise<Response> {
    const sessionKey = `mcp:session:${agentId}:${mcpId}`;
    const sessionId = await this.getSession(sessionKey);

    // Look up per-user credential for this MCP
    let credentialToken: string | undefined;
    if (userId) {
      const token = await this.resolveCredentialToken(agentId, userId, mcpId);
      if (token) credentialToken = token;
    }

    // SSRF protection: block requests to internal networks
    if (await isInternalUrl(httpServer.upstreamUrl)) {
      logger.warn("Blocked SSRF attempt to internal URL", {
        url: httpServer.upstreamUrl,
        mcpId,
        agentId,
      });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32600,
            message: "Upstream URL resolves to a blocked internal network",
          },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    const headers = this.buildUpstreamHeaders(
      sessionId,
      httpServer.headers,
      credentialToken
    );

    const response = await fetch(httpServer.upstreamUrl, {
      method,
      headers,
      body: body || undefined,
    });

    // Track session
    const newSessionId = response.headers.get("Mcp-Session-Id");
    if (newSessionId) {
      await this.setSession(sessionKey, newSessionId);
    }

    return response;
  }

  private async forwardRequest(
    c: Context,
    httpServer: HttpMcpServerConfig,
    agentId: string,
    mcpId: string,
    userId?: string
  ): Promise<Response> {
    // SSRF protection: block requests to internal networks
    if (await isInternalUrl(httpServer.upstreamUrl)) {
      logger.warn("Blocked SSRF attempt to internal URL", {
        url: httpServer.upstreamUrl,
        mcpId,
        agentId,
      });
      return this.sendJsonRpcError(
        c,
        -32600,
        "Upstream URL resolves to a blocked internal network"
      );
    }

    const sessionKey = `mcp:session:${agentId}:${mcpId}`;
    let sessionId = await this.getSession(sessionKey);

    const bodyText = await this.getRequestBodyAsText(c);

    // Body size validation
    if (bodyText.length > MAX_BODY_SIZE) {
      logger.warn("Request body too large", {
        mcpId,
        agentId,
        size: bodyText.length,
      });
      return new Response("Request body too large", { status: 413 });
    }

    // If no active session exists, re-initialize before forwarding
    if (!sessionId && c.req.method === "POST") {
      try {
        await this.reinitializeSession(httpServer, agentId, mcpId, userId);
        sessionId = await this.getSession(sessionKey);
      } catch (error) {
        logger.warn("Pre-emptive MCP re-initialization failed", {
          mcpId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info("Proxying MCP request", {
      mcpId,
      agentId,
      method: c.req.method,
      hasSession: !!sessionId,
      bodyLength: bodyText.length,
    });

    // Look up per-user credential for this MCP
    let credentialToken: string | undefined;
    if (userId) {
      const token = await this.resolveCredentialToken(agentId, userId, mcpId);
      if (token) credentialToken = token;
    }

    const headers = this.buildUpstreamHeaders(
      sessionId,
      httpServer.headers,
      credentialToken
    );

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
   * Re-initialize an MCP session by sending initialize + notifications/initialized.
   * Called when upstream returns "Server not initialized" (stale session).
   */
  private async reinitializeSession(
    httpServer: HttpMcpServerConfig,
    agentId: string,
    mcpId: string,
    userId?: string
  ): Promise<void> {
    // Clear stale session
    const sessionKey = `mcp:session:${agentId}:${mcpId}`;
    await this.redisClient.del(sessionKey).catch(() => {
      /* noop */
    });

    // Send initialize
    const initBody = JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "lobu-gateway", version: "1.0.0" },
      },
      id: 0,
    });

    const initResponse = await this.sendUpstreamRequest(
      httpServer,
      agentId,
      mcpId,
      "POST",
      initBody,
      userId
    );

    await initResponse.json(); // consume response

    // Send notifications/initialized
    const notifyBody = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    await this.sendUpstreamRequest(
      httpServer,
      agentId,
      mcpId,
      "POST",
      notifyBody,
      userId
    ).catch(() => {
      /* noop */
    });

    logger.info("Re-initialized MCP session", { mcpId, agentId });
  }

  /**
   * Auto-start device-code auth when an MCP upstream returns an auth error.
   * Returns a user-facing message with the verification URL, or null on failure.
   */
  private async tryAutoDeviceAuth(
    mcpId: string,
    agentId: string,
    userId: string
  ): Promise<string | null> {
    try {
      const { startDeviceAuth } = await import(
        "../../routes/internal/device-auth"
      );

      // Check if a device auth flow is already pending (avoid duplicate starts)
      const pendingKey = `device-auth:${agentId}:${userId}:${mcpId}`;
      const pending = await this.redisClient.get(pendingKey);
      if (pending) {
        // Return the existing pending flow's info instead of starting a new one
        return JSON.stringify({
          status: "login_required",
          message:
            "Authentication is required. A login flow is already in progress. STOP calling tools and tell the user to complete login in their browser. Do NOT retry this tool call.",
          note: "Do NOT call any owletto tools until the user completes login.",
        });
      }

      const result = await startDeviceAuth(
        this.redisClient,
        this.configService as any,
        mcpId,
        agentId,
        userId
      );
      if (!result) return null;
      const url = result.verificationUriComplete || result.verificationUri;
      return JSON.stringify({
        status: "login_required",
        message:
          "Authentication is required. STOP calling tools and show the user this login link and code. Do NOT retry this tool call — wait for the user to complete login first.",
        verification_url: url,
        user_code: result.userCode,
        expires_in_seconds: result.expiresIn,
      });
    } catch (error) {
      logger.warn("Auto device-auth failed", {
        mcpId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
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
}
