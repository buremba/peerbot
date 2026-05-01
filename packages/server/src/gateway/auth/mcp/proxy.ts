import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import { createLogger, verifyWorkerToken } from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import type { IMessageQueue } from "../../infrastructure/queue/index.js";
import { storePendingTool } from "./pending-tool-store.js";
import { requiresToolApproval } from "../../permissions/approval-policy.js";
import type { GrantStore } from "../../permissions/grant-store.js";
import {
  getStoredCredential,
  refreshCredential,
  tryCompletePendingDeviceAuth,
} from "../../routes/internal/device-auth.js";
import type { WritableSecretStore } from "../../secrets/index.js";
import { startAuthCodeFlow } from "./oauth-flow.js";
import type { CachedMcpServer, McpTool, McpToolCache } from "./tool-cache.js";

const logger = createLogger("mcp-proxy");

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

/**
 * Parse a JSON-RPC response body that may be either a plain JSON object
 * (Content-Type: application/json) or a single-event SSE stream
 * (Content-Type: text/event-stream). Streamable-HTTP MCP servers may return
 * either form per the MCP spec.
 */
async function parseJsonRpcResponse(response: Response): Promise<any> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    const text = await response.text();
    // SSE frames: sequence of `event:`/`data:` lines separated by blank lines.
    // For request/response JSON-RPC we expect the last `data:` payload to be
    // the JSON-RPC response object.
    let payload = "";
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        payload = line.slice(5).trimStart();
      }
    }
    if (!payload) {
      throw new Error("SSE response contained no data payload");
    }
    return JSON.parse(payload);
  }
  return response.json();
}

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
  oauth?: import("@lobu/core").McpOAuthConfig;
  inputs?: unknown[];
  headers?: Record<string, string>;
  /** Credential scoping strategy: "user" (default) or "channel" (shared in a Slack channel). */
  authScope?: "user" | "channel";
  /** True when the upstream is the same embedded Owletto process (lobu-memory). */
  internal?: boolean;
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

  return null;
}

export class McpProxy {
  private readonly SESSION_TTL_SECONDS = 30 * 60; // 30 minutes
  // Tool-approval cards may sit in-thread for a long time before the user
  // actually clicks (Slack notifications, async review, etc.). The pending
  // invocation key holds the args needed to execute the tool after approval;
  // 24h gives users a realistic window to respond. Anything shorter silently
  // drops late clicks (the take-on-claim returns null and the click no-ops).
  private readonly PENDING_TOOL_TTL = 24 * 60 * 60; // 24 hours
  /**
   * Per-process MCP upstream session-id cache. The session id is opaque to
   * the gateway and only valid for the upstream MCP server, so on a gateway
   * restart the worker simply re-runs `initialize` and gets a new session —
   * no cross-replica coherence needed.
   */
  private readonly sessions = new Map<string, { sessionId: string; expiresAt: number }>();
  private app: Hono;
  private readonly toolCache?: McpToolCache;
  private readonly secretStore: WritableSecretStore;
  private readonly grantStore?: GrantStore;
  private readonly publicGatewayUrl?: string;

  /** Callback invoked when a tool call is blocked for approval. */
  public onToolBlocked?: (
    requestId: string,
    agentId: string,
    userId: string,
    mcpId: string,
    toolName: string,
    args: Record<string, unknown>,
    grantPattern: string,
    channelId: string,
    conversationId: string,
    teamId: string | undefined,
    connectionId: string | undefined,
    platform: string | undefined
  ) => Promise<void>;

  /** Callback invoked when an MCP auth flow is started or already pending. */
  public onAuthRequired?: (
    agentId: string,
    userId: string,
    mcpId: string,
    payload: {
      status: "login_required" | "pending";
      url?: string;
      userCode?: string;
      message: string;
    },
    channelId: string,
    conversationId: string,
    teamId: string | undefined,
    connectionId: string | undefined,
    platform: string | undefined
  ) => Promise<void>;

  constructor(
    private readonly configService: McpConfigSource,
    _queue: IMessageQueue,
    options: {
      secretStore: WritableSecretStore;
      toolCache?: McpToolCache;
      grantStore?: GrantStore;
      /** Absolute gateway URL for OAuth redirect_uri construction. */
      publicGatewayUrl?: string;
    }
  ) {
    this.secretStore = options.secretStore;
    this.toolCache = options.toolCache;
    this.grantStore = options.grantStore;
    this.publicGatewayUrl = options.publicGatewayUrl;
    this.app = new Hono();
    this.setupRoutes();
    logger.debug("MCP proxy initialized");
  }

  getApp(): Hono {
    return this.app;
  }

  /**
   * Execute an MCP tool call directly (internal use, no HTTP auth).
   * Used by the interaction bridge to execute tool calls after user approval.
   */
  async executeToolDirect(
    agentId: string,
    userId: string,
    mcpId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{
    content: Array<{ type: string; text: string }>;
    isError: boolean;
  }> {
    const httpServer = await this.configService.getHttpServer(mcpId, agentId);
    if (!httpServer) {
      return {
        content: [{ type: "text", text: `MCP server '${mcpId}' not found` }],
        isError: true,
      };
    }

    // executeToolDirect is called from the interaction bridge after user
    // approval, where no channelId is carried — so we can only honor
    // authScope="user" here. For channel-scoped servers, fall back to
    // userId (still correct for the requesting user's personal credential).
    const scopeKey = this.computeScopeKey(httpServer, userId, undefined);

    const jsonRpcBody = JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: toolName, arguments: args },
      id: 1,
    });

    try {
      const response = await this.sendUpstreamRequest(
        httpServer,
        agentId,
        mcpId,
        "POST",
        jsonRpcBody,
        scopeKey
      );

      if (!response.ok) {
        const text = await response.text();
        return {
          content: [
            {
              type: "text",
              text: `Tool call failed: ${response.status} ${text}`,
            },
          ],
          isError: true,
        };
      }

      const json = (await parseJsonRpcResponse(response)) as any;
      const result = json.result || json;
      return {
        content: result.content || [
          { type: "text", text: JSON.stringify(result) },
        ],
        isError: result.isError || false,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Tool execution error: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
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
    tokenData: any,
    workerToken?: string
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
    const channelId = tokenData?.channelId || "";
    const scopeKey = this.computeScopeKey(httpServer, userId, channelId);

    try {
      // Clear any stale session before fresh tool discovery
      const sessionKey = this.buildSessionKey(agentId, mcpId, scopeKey);
      await this.deleteSession(sessionKey);

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
          scopeKey,
          workerToken
        );

        // Tool discovery runs before the agent has a chance to call anything.
        // If the server demands OAuth, kick off the auth-code flow here so the
        // "Connect X" link reaches the user up-front.
        if (initResponse.status === 401) {
          const wwwAuth = initResponse.headers.get("www-authenticate");
          await initResponse.body?.cancel().catch(() => {
            /* noop */
          });
          await this.fireAuthCodeFlowFromDiscovery({
            mcpId,
            agentId,
            httpServer,
            wwwAuthenticate: wwwAuth,
            scopeKey,
            tokenData,
          });
          return { tools: [] };
        }

        const initData = (await parseJsonRpcResponse(initResponse)) as {
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
          scopeKey,
          workerToken
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
        scopeKey,
        workerToken
      );

      if (response.status === 401) {
        const wwwAuth = response.headers.get("www-authenticate");
        await response.body?.cancel().catch(() => {
          /* noop */
        });
        await this.fireAuthCodeFlowFromDiscovery({
          mcpId,
          agentId,
          httpServer,
          wwwAuthenticate: wwwAuth,
          scopeKey,
          tokenData,
        });
        return { tools: [] };
      }

      const data = (await parseJsonRpcResponse(response)) as JsonRpcResponse;
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
          scopeKey,
          workerToken
        );
        const retryData = (await parseJsonRpcResponse(
          retryResponse
        )) as JsonRpcResponse;
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
    const scopeKey = this.computeScopeKey(
      httpServer,
      requesterUserId,
      auth.tokenData.channelId || ""
    );

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
        scopeKey
      );

      const data = (await parseJsonRpcResponse(response)) as JsonRpcResponse;
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
    const channelId = auth.tokenData.channelId || "";
    const scopeKey = this.computeScopeKey(
      httpServer,
      requesterUserId,
      channelId
    );

    // Parse body early so tool arguments are available for the approval message.
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

          if (this.onToolBlocked) {
            const requestId = `ta_${randomUUID()}`;
            await storePendingTool(
              requestId,
              {
                mcpId,
                toolName,
                args: toolArguments,
                agentId,
                userId: requesterUserId,
                channelId: auth.tokenData.channelId || "",
                conversationId: auth.tokenData.conversationId || "",
                teamId: auth.tokenData.teamId,
                connectionId: auth.tokenData.connectionId,
              },
              this.PENDING_TOOL_TTL
            ).catch((err: unknown) =>
              logger.error(
                { requestId, error: String(err) },
                "Failed to store pending tool invocation"
              )
            );

            await this.onToolBlocked(
              requestId,
              agentId,
              requesterUserId,
              mcpId,
              toolName,
              toolArguments,
              pattern,
              auth.tokenData.channelId || "",
              auth.tokenData.conversationId || "",
              auth.tokenData.teamId,
              auth.tokenData.connectionId,
              auth.tokenData.platform
            ).catch((err) =>
              logger.error(
                { requestId, error: String(err) },
                "onToolBlocked callback failed"
              )
            );

            return c.json(
              {
                content: [
                  {
                    type: "text",
                    text: "Tool call requires approval. The user has been asked to approve. Your session will end. The result will arrive as your next message.",
                  },
                ],
                isError: true,
              },
              403
            );
          }

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
        scopeKey,
        auth.token
      );

      // Detect HTTP 401 + WWW-Authenticate → start MCP OAuth 2.1 auth-code flow.
      // This path runs before JSON-RPC parsing because most compliant MCP
      // servers (Sentry, etc.) return 401 at the transport layer, not a
      // JSON-RPC error body.
      if (response.status === 401) {
        const wwwAuth = response.headers.get("www-authenticate");
        // Drain body so the connection can be reused.
        await response.body?.cancel().catch(() => {
          /* noop */
        });
        const authCodeResult = await this.tryAutoAuthCodeFlow({
          mcpId,
          agentId,
          userId: requesterUserId,
          scopeKey,
          httpServer,
          wwwAuthenticate: wwwAuth,
          platform: auth.tokenData.platform,
          channelId,
          conversationId: auth.tokenData.conversationId || "",
          teamId: auth.tokenData.teamId,
          connectionId: auth.tokenData.connectionId,
        });
        if (authCodeResult) {
          if (this.onAuthRequired) {
            await this.onAuthRequired(
              agentId,
              requesterUserId,
              mcpId,
              authCodeResult,
              channelId,
              auth.tokenData.conversationId || "",
              auth.tokenData.teamId,
              auth.tokenData.connectionId,
              auth.tokenData.platform
            ).catch((err) =>
              logger.error(
                { mcpId, error: String(err) },
                "onAuthRequired callback failed"
              )
            );
          }
          return c.json(
            {
              content: [{ type: "text", text: JSON.stringify(authCodeResult) }],
              isError: true,
            },
            200
          );
        }
        // Fall through to device-auth legacy fallback if auth-code flow failed.
        const legacyAuth = await this.tryAutoDeviceAuth(
          mcpId,
          agentId,
          requesterUserId
        );
        if (legacyAuth) {
          if (this.onAuthRequired) {
            await this.onAuthRequired(
              agentId,
              requesterUserId,
              mcpId,
              legacyAuth,
              channelId,
              auth.tokenData.conversationId || "",
              auth.tokenData.teamId,
              auth.tokenData.connectionId,
              auth.tokenData.platform
            ).catch((err) =>
              logger.error(
                { mcpId, error: String(err) },
                "onAuthRequired callback failed"
              )
            );
          }
          return c.json(
            {
              content: [{ type: "text", text: JSON.stringify(legacyAuth) }],
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
                text: `Authentication required for ${mcpId} but OAuth discovery failed.`,
              },
            ],
            isError: true,
          },
          200
        );
      }

      let data = (await parseJsonRpcResponse(response)) as JsonRpcResponse;

      // Re-initialize session and retry on stale-session errors.
      //
      // Primary signal: MCP streamable-HTTP transport mandates HTTP 404 when
      // the `Mcp-Session-Id` header names a session the server no longer
      // knows (e.g. upstream restarted while we held the id cached).
      //
      // Fallback signal: some MCP servers return 200 with a JSON-RPC error
      // whose message is "Server not initialized" or "Session not found…".
      // We match both wordings rather than chase specific upstream phrasing.
      if (
        response.status === 404 ||
        (data?.error &&
          /not initialized|session not found/i.test(data.error.message || ""))
      ) {
        logger.info("MCP session expired, re-initializing before retry", {
          mcpId,
          toolName,
        });
        await this.reinitializeSession(httpServer, agentId, mcpId, scopeKey, auth.token);

        response = await this.sendUpstreamRequest(
          httpServer,
          agentId,
          mcpId,
          "POST",
          jsonRpcBody,
          scopeKey,
          auth.token
        );
        data = (await parseJsonRpcResponse(response)) as JsonRpcResponse;
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
            scopeKey
          );
          if (autoAuthResult) {
            if (this.onAuthRequired) {
              await this.onAuthRequired(
                agentId,
                requesterUserId,
                mcpId,
                autoAuthResult,
                auth.tokenData.channelId || "",
                auth.tokenData.conversationId || "",
                auth.tokenData.teamId,
                auth.tokenData.connectionId,
                auth.tokenData.platform
              ).catch((err) =>
                logger.error(
                  { mcpId, error: String(err) },
                  "onAuthRequired callback failed"
                )
              );
            }
            return c.json(
              {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(autoAuthResult),
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
                  text: `Authentication required for ${mcpId}. Call ${mcpId}_login to authenticate.`,
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
          auth.tokenData,
          auth.token
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

    // Check tool approval for tools/call JSON-RPC requests.
    // Clone the request so the body can be read twice (once here, once in forwardRequest).
    if (this.grantStore && c.req.method === "POST") {
      try {
        const clonedReq = c.req.raw.clone();
        const bodyText = await clonedReq.text();
        if (bodyText) {
          const jsonRpc = JSON.parse(bodyText);
          if (jsonRpc.method === "tools/call" && jsonRpc.params?.name) {
            const toolName = jsonRpc.params.name;
            const toolArgs = jsonRpc.params.arguments || {};
            // TODO(#254): pre-tool-stage guardrail hook. Before the existing
            // approval check below, call runGuardrails("pre-tool", registry,
            // settings.guardrails, { toolName, arguments: toolArgs, agentId, ...}).
            // On trip: reuse the onToolBlocked path to return a JSON-RPC error
            // with trip.reason. Wiring deferred to the PR that registers the
            // first real pre-tool guardrail.
            const { found, annotations } = await this.getToolAnnotations(
              mcpId!,
              toolName,
              agentId,
              tokenData
            );
            if (found && requiresToolApproval(annotations)) {
              const pattern = `/mcp/${mcpId}/tools/${toolName}`;
              const hasGrant = await this.grantStore.hasGrant(agentId, pattern);
              if (!hasGrant) {
                logger.info("Tool call blocked (JSON-RPC): requires approval", {
                  agentId,
                  mcpId,
                  toolName,
                  pattern,
                });

                if (this.onToolBlocked) {
                  const requestId = `ta_${randomUUID()}`;
                  await storePendingTool(
                    requestId,
                    {
                      mcpId: mcpId!,
                      toolName,
                      args: toolArgs,
                      agentId,
                      userId: tokenData.userId,
                      channelId: tokenData.channelId || "",
                      conversationId: tokenData.conversationId || "",
                      teamId: tokenData.teamId,
                      connectionId: tokenData.connectionId,
                    },
                    this.PENDING_TOOL_TTL
                  ).catch((err: unknown) =>
                    logger.error(
                      { requestId, error: String(err) },
                      "Failed to store pending tool invocation"
                    )
                  );

                  await this.onToolBlocked(
                    requestId,
                    agentId,
                    tokenData.userId,
                    mcpId!,
                    toolName,
                    toolArgs,
                    pattern,
                    tokenData.channelId || "",
                    tokenData.conversationId || "",
                    tokenData.teamId,
                    tokenData.connectionId,
                    tokenData.platform
                  ).catch((err) =>
                    logger.error(
                      { requestId, error: String(err) },
                      "onToolBlocked callback failed"
                    )
                  );
                }

                return c.json({
                  jsonrpc: "2.0",
                  id: jsonRpc.id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: "Tool call requires approval. The user has been asked to approve. Your session will end. The result will arrive as your next message.",
                      },
                    ],
                    isError: true,
                  },
                });
              }
            }
          }
        }
      } catch {
        // If body parsing fails, just forward the request as-is
      }
    }

    const channelId = tokenData.channelId || "";
    const scopeKey = this.computeScopeKey(
      httpServer,
      tokenData.userId,
      channelId
    );

    try {
      return await this.forwardRequest(
        c,
        httpServer,
        agentId,
        mcpId!,
        scopeKey,
        {
          userId: tokenData.userId,
          platform: tokenData.platform,
          channelId,
          conversationId: tokenData.conversationId || "",
          teamId: tokenData.teamId,
          connectionId: tokenData.connectionId,
          workerToken: sessionToken,
        }
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
    credentialToken?: string,
    internal?: boolean
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // MCP streamable-HTTP spec requires both — servers like DeepWiki reject
      // plain `application/json` with 406 Not Acceptable.
      Accept: "application/json, text/event-stream",
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

    // Stamp internal MCP requests so the embedded Owletto multi-tenant
    // middleware promotes the worker JWT to admin scope for this org.
    if (internal) {
      headers["X-Lobu-Memory-Direct-Auth"] = "1";
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
      this.secretStore,
      agentId,
      userId,
      mcpId
    );
    if (!credential) {
      // No stored credential — check if there's a pending device-auth to complete
      return tryCompletePendingDeviceAuth(
        this.secretStore,
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
      this.secretStore,
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
    scopeKey?: string,
    directAuthToken?: string
  ): Promise<Response> {
    const sessionKey = this.buildSessionKey(agentId, mcpId, scopeKey);
    const sessionId = await this.getSession(sessionKey);

    // Internal MCPs (lobu-memory) live in the same Owletto process and accept
    // the worker JWT directly; forcing a second OAuth login would block
    // unattended watcher runs. Non-internal MCPs use per-user credentials.
    let credentialToken: string | undefined;
    if (httpServer.internal) {
      credentialToken = directAuthToken;
    } else if (scopeKey) {
      const token = await this.resolveCredentialToken(agentId, scopeKey, mcpId);
      if (token) credentialToken = token;
    }

    if (!httpServer.internal && (await isInternalUrl(httpServer.upstreamUrl))) {
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
      credentialToken,
      httpServer.internal === true
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
    scopeKey?: string,
    authContext?: {
      userId: string;
      platform?: string;
      channelId: string;
      conversationId: string;
      teamId?: string;
      connectionId?: string;
      workerToken?: string;
    }
  ): Promise<Response> {
    if (!httpServer.internal && (await isInternalUrl(httpServer.upstreamUrl))) {
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

    const sessionKey = this.buildSessionKey(agentId, mcpId, scopeKey);
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

    // Internal MCPs (lobu-memory) accept the worker JWT directly; forcing a
    // second OAuth login would block unattended watcher runs. Non-internal
    // MCPs use per-user credentials.
    let credentialToken: string | undefined;
    if (httpServer.internal) {
      credentialToken = authContext?.workerToken;
    } else if (scopeKey) {
      const token = await this.resolveCredentialToken(agentId, scopeKey, mcpId);
      if (token) credentialToken = token;
    }

    // If no active session exists, re-initialize before forwarding
    if (!sessionId && c.req.method === "POST") {
      try {
        await this.reinitializeSession(httpServer, agentId, mcpId, scopeKey, credentialToken);
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

    const headers = this.buildUpstreamHeaders(
      sessionId,
      httpServer.headers,
      credentialToken,
      httpServer.internal === true
    );

    let response = await fetch(httpServer.upstreamUrl, {
      method: c.req.method,
      headers,
      body: bodyText || undefined,
    });

    // Detect HTTP 401 + WWW-Authenticate → start MCP OAuth 2.1 auth-code flow.
    if (response.status === 401 && authContext) {
      const wwwAuth = response.headers.get("www-authenticate");
      await response.body?.cancel().catch(() => {
        /* noop */
      });
      const authCodeResult = await this.tryAutoAuthCodeFlow({
        mcpId,
        agentId,
        userId: authContext.userId,
        scopeKey: scopeKey ?? authContext.userId,
        httpServer,
        wwwAuthenticate: wwwAuth,
        platform: authContext.platform ?? "",
        channelId: authContext.channelId,
        conversationId: authContext.conversationId,
        teamId: authContext.teamId,
        connectionId: authContext.connectionId,
      });
      if (authCodeResult && this.onAuthRequired) {
        await this.onAuthRequired(
          agentId,
          authContext.userId,
          mcpId,
          authCodeResult,
          authContext.channelId,
          authContext.conversationId,
          authContext.teamId,
          authContext.connectionId,
          authContext.platform
        ).catch((err) =>
          logger.error(
            { mcpId, error: String(err) },
            "onAuthRequired callback failed (forward)"
          )
        );
      }
      const payload = authCodeResult ?? {
        status: "login_required" as const,
        message: `Authentication required for ${mcpId}.`,
      };
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          result: {
            content: [{ type: "text", text: JSON.stringify(payload) }],
            isError: true,
          },
        },
        200
      );
    }

    // Stale-session recovery: if upstream returns 404 we sent a session id
    // it no longer recognizes (e.g. server restart). Drop the cached id,
    // re-init, and retry once with the same payload. Only meaningful for
    // POST — GET/DELETE on an unknown session should surface the 404 as-is.
    if (
      response.status === 404 &&
      sessionId &&
      c.req.method === "POST" &&
      bodyText
    ) {
      logger.info(
        "Upstream 404 on cached session id — re-initializing and retrying",
        { mcpId, agentId }
      );
      try {
        await this.reinitializeSession(httpServer, agentId, mcpId, scopeKey, credentialToken);
        sessionId = await this.getSession(sessionKey);
        const retryHeaders = this.buildUpstreamHeaders(
          sessionId,
          httpServer.headers,
          credentialToken,
          httpServer.internal === true
        );
        response = await fetch(httpServer.upstreamUrl, {
          method: c.req.method,
          headers: retryHeaders,
          body: bodyText,
        });
      } catch (error) {
        logger.warn("Stale-session recovery failed on forward", {
          mcpId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

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
    scopeKey?: string,
    directAuthToken?: string
  ): Promise<void> {
    // Clear stale session
    const sessionKey = this.buildSessionKey(agentId, mcpId, scopeKey);
    await this.deleteSession(sessionKey);

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
      scopeKey,
      directAuthToken
    );

    await initResponse.text(); // consume response (may be JSON or SSE-framed)

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
      scopeKey,
      directAuthToken
    ).catch(() => {
      /* noop */
    });

    logger.info("Re-initialized MCP session", { mcpId, agentId });
  }

  /**
   * Shared helper: on 401 during tool discovery, start the OAuth auth-code
   * flow and surface the "Connect X" link to the user via onAuthRequired.
   * Silently noops on failure — caller already degrades to `{ tools: [] }`.
   */
  private async fireAuthCodeFlowFromDiscovery(params: {
    mcpId: string;
    agentId: string;
    httpServer: HttpMcpServerConfig;
    wwwAuthenticate: string | null;
    scopeKey: string;
    tokenData: any;
  }): Promise<void> {
    const { mcpId, agentId, httpServer, wwwAuthenticate, scopeKey, tokenData } =
      params;
    const userId = tokenData?.userId || scopeKey;
    const channelId = tokenData?.channelId || "";
    const conversationId = tokenData?.conversationId || "";
    const platform = tokenData?.platform;

    const result = await this.tryAutoAuthCodeFlow({
      mcpId,
      agentId,
      userId,
      scopeKey,
      httpServer,
      wwwAuthenticate,
      platform: platform ?? "",
      channelId,
      conversationId,
      teamId: tokenData?.teamId,
      connectionId: tokenData?.connectionId,
    });
    if (!result || !this.onAuthRequired) return;

    await this.onAuthRequired(
      agentId,
      userId,
      mcpId,
      result,
      channelId,
      conversationId,
      tokenData?.teamId,
      tokenData?.connectionId,
      platform
    ).catch((err) =>
      logger.error(
        { mcpId, error: String(err) },
        "onAuthRequired callback failed (discovery)"
      )
    );
  }

  /**
   * Compute the credential scope key from the server config + request context.
   * Returns `channel-<channelId>` when `authScope === "channel"` (and channelId
   * is present), otherwise `userId` for per-user scope.
   */
  private computeScopeKey(
    httpServer: HttpMcpServerConfig,
    userId: string,
    channelId: string | undefined
  ): string {
    if (httpServer.authScope === "channel" && channelId) {
      return `channel-${channelId}`;
    }
    return userId;
  }

  /**
   * Build a session-store key for the upstream Mcp-Session-Id associated
   * with a specific (agent, mcp, scope) triple. Scoping by scopeKey prevents
   * two users (or user-vs-channel credentials) from sharing a single
   * upstream session, which would leak context across scopes.
   */
  private buildSessionKey(
    agentId: string,
    mcpId: string,
    scopeKey?: string
  ): string {
    const scope = scopeKey ?? "_unscoped";
    return `mcp:session:${agentId}:${mcpId}:${scope}`;
  }

  /**
   * Auto-start MCP OAuth 2.1 authorization-code + PKCE flow when an upstream
   * returns 401. Uses WWW-Authenticate header to walk the RFC 9728 → 8414 →
   * 7591 discovery chain. Returns a payload for `onAuthRequired`, or null on
   * failure (caller should fall back to device-auth).
   */
  private async tryAutoAuthCodeFlow(params: {
    mcpId: string;
    agentId: string;
    userId: string;
    scopeKey: string;
    httpServer: HttpMcpServerConfig;
    wwwAuthenticate: string | null;
    platform: string;
    channelId: string;
    conversationId: string;
    teamId?: string;
    connectionId?: string;
  }): Promise<{
    status: "login_required";
    url: string;
    message: string;
  } | null> {
    if (!this.publicGatewayUrl) {
      logger.warn("Auth-code flow skipped: publicGatewayUrl not configured", {
        mcpId: params.mcpId,
      });
      return null;
    }

    try {
      const redirectUri = `${this.publicGatewayUrl.replace(/\/+$/, "")}/mcp/oauth/callback`;
      const { authorizationUrl } = await startAuthCodeFlow({
        secretStore: this.secretStore,
        mcpId: params.mcpId,
        upstreamUrl: params.httpServer.upstreamUrl,
        agentId: params.agentId,
        userId: params.userId,
        scopeKey: params.scopeKey,
        wwwAuthenticate: params.wwwAuthenticate,
        redirectUri,
        staticOauth: params.httpServer.oauth,
        platform: params.platform,
        channelId: params.channelId,
        conversationId: params.conversationId,
        teamId: params.teamId,
        connectionId: params.connectionId,
      });
      return {
        status: "login_required",
        url: authorizationUrl,
        message:
          "Authentication is required. STOP calling tools and show the user this login link. Do NOT retry this tool call — wait for the user to complete login in their browser first.",
      };
    } catch (error) {
      logger.warn("Auto auth-code flow failed", {
        mcpId: params.mcpId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Auto-start device-code auth when an MCP upstream returns an auth error.
   * Returns a user-facing message with the verification URL, or null on failure.
   */
  private async tryAutoDeviceAuth(
    mcpId: string,
    agentId: string,
    userId: string
  ): Promise<{
    status: "login_required" | "pending";
    url?: string;
    userCode?: string;
    message: string;
    expiresInSeconds?: number;
  } | null> {
    try {
      const { startDeviceAuth } = await import(
        "../../routes/internal/device-auth.js"
      );

      // Existing-flow detection now happens inside startDeviceAuth — it
      // reuses any non-expired pending flow already persisted in the secret
      // store and returns it instead of restarting.
      const result = await startDeviceAuth(
        this.secretStore,
        this.configService as any,
        mcpId,
        agentId,
        userId
      );
      if (!result) return null;
      const url = result.verificationUriComplete || result.verificationUri;
      return {
        status: "login_required",
        url,
        userCode: result.userCode,
        message:
          "Authentication is required. STOP calling tools and show the user this login link and code. Do NOT retry this tool call — wait for the user to complete login first.",
        expiresInSeconds: result.expiresIn,
      };
    } catch (error) {
      logger.warn("Auto device-auth failed", {
        mcpId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async getSession(key: string): Promise<string | null> {
    const entry = this.sessions.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.sessions.delete(key);
      return null;
    }
    // Refresh TTL on read.
    entry.expiresAt = Date.now() + this.SESSION_TTL_SECONDS * 1000;
    return entry.sessionId;
  }

  private async setSession(key: string, sessionId: string): Promise<void> {
    this.sessions.set(key, {
      sessionId,
      expiresAt: Date.now() + this.SESSION_TTL_SECONDS * 1000,
    });
  }

  private async deleteSession(key: string): Promise<void> {
    this.sessions.delete(key);
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
