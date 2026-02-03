import { createLogger, verifyWorkerToken } from "@peerbot/core";
import type { Context } from "hono";
import { Hono } from "hono";
import type { IMessageQueue } from "../../infrastructure/queue";
import { GenericOAuth2Client } from "../oauth/generic-client";
import type { McpConfigService } from "./config-service";
import type { McpCredentialStore } from "./credential-store";
import type { McpInputStore } from "./input-store";
import { mcpConfigStore } from "./mcp-config-store";
import { substituteObject, substituteString } from "./string-substitution";

const logger = createLogger("mcp-proxy");

export class McpProxy {
  private readonly oauth2Client = new GenericOAuth2Client();
  private readonly SESSION_TTL_SECONDS = 30 * 60; // 30 minutes
  private readonly redisClient: any;
  private app: Hono;

  constructor(
    private readonly configService: McpConfigService,
    private readonly credentialStore: McpCredentialStore,
    private readonly inputStore: McpInputStore,
    queue: IMessageQueue
  ) {
    this.redisClient = queue.getRedisClient();
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

  private setupRoutes() {
    // Handle MCP HTTP protocol endpoints (Claude Code HTTP transport)
    // Claude Code HTTP transport POSTs to the exact URL configured
    // Since we configure http://gateway:8080, it POSTs to http://gateway:8080/
    // We use X-Mcp-Id header to identify which MCP server

    // Main endpoint - Claude Code POSTs JSON-RPC to root path
    // Note: The root "/" check with X-Mcp-Id header is handled in gateway.ts
    // This route handles requests already routed to /mcp/*

    // Legacy endpoints (if needed for other MCP transports)
    this.app.all("/register", (c) => this.handleProxyRequest(c));
    this.app.all("/message", (c) => this.handleProxyRequest(c));

    // Path-based routes (for SSE or other transports)
    this.app.all("/:mcpId", (c) => this.handleProxyRequest(c));
    this.app.all("/:mcpId/*", (c) => this.handleProxyRequest(c));
  }

  private async handleProxyRequest(c: Context): Promise<Response> {
    // Extract MCP ID from either URL path or X-Mcp-Id header
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

    // Try global MCP config first
    let httpServer = await this.configService.getHttpServer(mcpId!);
    let isPerAgentMcp = false;

    // If not found in global config, check per-agent MCP config
    if (!httpServer && tokenData.deploymentName) {
      const agentMcpConfig = await mcpConfigStore.get(tokenData.deploymentName);
      const perAgentMcp = agentMcpConfig?.mcpServers?.[mcpId!];
      if (perAgentMcp?.url) {
        // Create a minimal httpServer-like object for per-agent HTTP MCPs
        httpServer = {
          id: mcpId!,
          upstreamUrl: perAgentMcp.url,
          // Per-agent MCPs don't support OAuth/inputs through the proxy
          // They connect directly to the upstream URL
        } as any;
        isPerAgentMcp = true;
        logger.info(`Using per-agent MCP config for ${mcpId}`, {
          deploymentName: tokenData.deploymentName,
          upstreamUrl: perAgentMcp.url,
        });
      }
    }

    if (!httpServer) {
      return this.sendJsonRpcError(
        c,
        -32601,
        `MCP server '${mcpId}' not found`
      );
    }

    // Check authentication - OAuth or inputs (skip for per-agent MCPs)
    let credentials = null;
    let inputValues = null;

    // Per-agent MCPs bypass OAuth/input checks - they connect directly to upstream
    if (isPerAgentMcp) {
      logger.info(`Per-agent MCP ${mcpId} - bypassing OAuth/input checks`);
    }

    // Check if MCP requires OAuth (static or discovered) - only for global MCPs
    const hasOAuth = !isPerAgentMcp && !!httpServer.oauth;
    const discoveredOAuth = !isPerAgentMcp
      ? await this.configService.getDiscoveredOAuth(mcpId!)
      : null;
    const hasDiscoveredOAuth = !!discoveredOAuth;

    // Get agentId from token data (fallback to userId for backwards compatibility)
    const agentId = tokenData.agentId || tokenData.userId;

    // Try OAuth credentials first (supports both static and discovered OAuth)
    if (hasOAuth || hasDiscoveredOAuth) {
      credentials = await this.credentialStore.getCredentials(agentId, mcpId!);

      if (!credentials || !credentials.accessToken) {
        logger.info("MCP OAuth credentials missing", {
          agentId,
          mcpId,
        });
        return this.sendJsonRpcError(
          c,
          -32002,
          `MCP '${mcpId}' requires authentication. Please authenticate via the Slack app home tab.`
        );
      }

      // Check if token is expired and attempt refresh
      if (credentials.expiresAt && credentials.expiresAt <= Date.now()) {
        logger.info("MCP access token expired, attempting refresh", {
          agentId,
          mcpId,
          hasRefreshToken: !!credentials.refreshToken,
        });

        if (credentials.refreshToken) {
          try {
            // Get OAuth config (static or discovered)
            let oauthConfig = httpServer.oauth;

            if (!oauthConfig && discoveredOAuth?.metadata) {
              // Build OAuth config from discovered metadata
              const discoveryService = this.configService.getDiscoveryService();
              if (!discoveryService) {
                throw new Error("OAuth discovery service not available");
              }

              const clientCredentials =
                await discoveryService.getOrCreateClientCredentials(
                  mcpId!,
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
                tokenEndpointAuthMethod:
                  clientCredentials.token_endpoint_auth_method,
              };
            }

            if (!oauthConfig) {
              throw new Error("No OAuth config available for refresh");
            }

            // Attempt to refresh the token
            const refreshedCredentials = await this.oauth2Client.refreshToken(
              credentials.refreshToken,
              oauthConfig
            );

            // Store the new credentials (without TTL)
            await this.credentialStore.setCredentials(
              agentId,
              mcpId!,
              refreshedCredentials
            );

            // Use the refreshed credentials
            credentials = refreshedCredentials;

            logger.info("Successfully refreshed MCP access token", {
              agentId,
              mcpId,
            });
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
        logger.info("MCP input values missing", {
          agentId,
          mcpId,
        });
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
   * This allows the MCP SDK to handle errors gracefully instead of failing
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
        error: {
          code,
          message,
        },
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

    // Get request body
    let bodyText = await this.getRequestBodyAsText(c);

    logger.info("Proxying MCP request", {
      mcpId,
      agentId,
      method: c.req.method,
      hasSession: !!sessionId,
      bodyLength: bodyText.length,
      hasInputValues: Object.keys(inputValues).length > 0,
    });

    // Build headers for upstream request
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };

    // Add session ID if we have one
    if (sessionId) {
      headers["Mcp-Session-Id"] = sessionId;
    }

    // Add OAuth token if provided
    if (credentials?.accessToken) {
      headers.Authorization = `Bearer ${credentials.accessToken}`;
    }

    // Apply input substitution to headers and body if inputs are provided
    if (Object.keys(inputValues).length > 0) {
      // Substitute placeholders in all header values
      for (const [key, value] of Object.entries(headers)) {
        headers[key] = substituteString(value, inputValues);
      }

      // Substitute placeholders in request body
      if (bodyText) {
        try {
          const bodyJson = JSON.parse(bodyText);
          const substitutedBody = substituteObject(bodyJson, inputValues);
          bodyText = JSON.stringify(substitutedBody);

          logger.debug("Applied input substitution to request body", {
            mcpId,
            agentId,
          });
        } catch {
          // If body is not JSON, apply string substitution directly
          bodyText = substituteString(bodyText, inputValues);
        }
      }
    }

    // Forward to upstream MCP - stream response directly back
    const response = await fetch(httpServer.upstreamUrl, {
      method: c.req.method,
      headers,
      body: bodyText || undefined,
    });

    // Extract and store session ID from response
    const newSessionId = response.headers.get("Mcp-Session-Id");
    if (newSessionId) {
      await this.setSession(sessionKey, newSessionId);
      logger.debug("Stored MCP session ID", {
        mcpId,
        agentId,
        sessionId: newSessionId,
      });
    }

    // Build response headers
    const responseHeaders = new Headers();
    const contentType = response.headers.get("content-type");
    if (contentType) {
      responseHeaders.set("Content-Type", contentType);
    }
    if (newSessionId) {
      responseHeaders.set("Mcp-Session-Id", newSessionId);
    }

    // Return streaming response
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
   * Get session ID from Redis
   */
  private async getSession(key: string): Promise<string | null> {
    try {
      const sessionId = await this.redisClient.get(key);
      if (sessionId) {
        // Refresh TTL on access
        await this.redisClient.expire(key, this.SESSION_TTL_SECONDS);
      }
      return sessionId;
    } catch (error) {
      logger.error("Failed to get MCP session from Redis", { key, error });
      return null;
    }
  }

  /**
   * Store session ID in Redis with TTL
   */
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
