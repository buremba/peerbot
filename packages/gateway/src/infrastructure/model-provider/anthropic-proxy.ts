import { createLogger } from "@peerbot/core";
import type { Context } from "hono";
import { Hono } from "hono";
import type { ClaudeCredentialStore } from "../../auth/claude/credential-store";
import { ClaudeOAuthClient } from "../../auth/oauth/claude-client";

const logger = createLogger("dispatcher");

interface AnthropicProxyConfig {
  enabled: boolean;
  anthropicApiKey?: string; // Now optional - may not be set if using OAuth
  anthropicBaseUrl?: string;
}

export class AnthropicProxy {
  private app: Hono;
  private config: AnthropicProxyConfig;
  private credentialStore?: ClaudeCredentialStore;
  private oauthClient: ClaudeOAuthClient;
  private refreshLocks: Map<string, Promise<string | null>>; // agentId -> refresh promise

  constructor(
    config: AnthropicProxyConfig,
    credentialStore?: ClaudeCredentialStore
  ) {
    this.config = config;
    this.credentialStore = credentialStore;
    this.oauthClient = new ClaudeOAuthClient();
    this.refreshLocks = new Map();
    this.app = new Hono();
    this.setupRoutes();
  }

  getApp(): Hono {
    return this.app;
  }

  /**
   * Refresh an expired OAuth token for a space
   * Uses locking to prevent concurrent refresh attempts for the same space
   * Returns the new access token or null if refresh failed
   */
  private async refreshSpaceToken(agentId: string): Promise<string | null> {
    // Check if there's already a refresh in progress for this space
    const existingRefresh = this.refreshLocks.get(agentId);
    if (existingRefresh) {
      logger.info(`Waiting for existing token refresh for space ${agentId}`);
      return existingRefresh;
    }

    // Create a new refresh promise and store it
    const refreshPromise = this.performTokenRefresh(agentId);
    this.refreshLocks.set(agentId, refreshPromise);

    try {
      const result = await refreshPromise;
      return result;
    } finally {
      // Clean up the lock after refresh completes (success or failure)
      this.refreshLocks.delete(agentId);
    }
  }

  /**
   * Perform the actual token refresh
   */
  private async performTokenRefresh(agentId: string): Promise<string | null> {
    if (!this.credentialStore) {
      logger.error("Cannot refresh token: credential store not available");
      return null;
    }

    try {
      // Get current credentials to access refresh token
      const credentials = await this.credentialStore.getCredentials(agentId);
      if (!credentials || !credentials.refreshToken) {
        logger.warn(`No refresh token available for space ${agentId}`);
        return null;
      }

      logger.info(`Refreshing expired token for space ${agentId}`);

      // Use ClaudeOAuthClient to refresh the token
      const newCredentials = await this.oauthClient.refreshToken(
        credentials.refreshToken
      );

      // Store the new credentials
      await this.credentialStore.setCredentials(agentId, newCredentials);

      logger.info(`Successfully refreshed token for space ${agentId}`);
      return newCredentials.accessToken;
    } catch (error) {
      logger.error(`Failed to refresh token for space ${agentId}`, { error });

      // If refresh failed, delete the invalid credentials
      try {
        await this.credentialStore.deleteCredentials(agentId);
        logger.info(`Deleted invalid credentials for space ${agentId}`);
      } catch (deleteError) {
        logger.error(`Failed to delete invalid credentials`, { deleteError });
      }

      return null;
    }
  }

  private setupRoutes(): void {
    // Health check for proxy
    this.app.get("/health", (c) => {
      return c.json({
        service: "anthropic-proxy",
        status: this.config.enabled ? "enabled" : "disabled",
        timestamp: new Date().toISOString(),
      });
    });

    // Proxy all other requests
    this.app.all("/*", async (c) => {
      return this.handleProxyRequest(c);
    });
  }

  private async handleProxyRequest(c: Context): Promise<Response> {
    if (!this.config.enabled) {
      return c.json({ error: "Anthropic proxy is disabled" }, 503);
    }

    try {
      // Forward request to Anthropic API
      return await this.forwardToAnthropic(c);
    } catch (error) {
      logger.error("Anthropic proxy error:", error);
      return c.json({ error: "Internal proxy error" }, 500);
    }
  }

  private async forwardToAnthropic(c: Context): Promise<Response> {
    // Authentication flow:
    // 1. Worker sends encrypted worker token via Claude SDK in x-api-key header
    // 2. Validate token and extract agentId
    // 3. Use agentId to get space's OAuth token (if available) or fall back to system API key
    // 4. Forward request to Anthropic with real credentials
    const workerToken = c.req.header("x-api-key");

    // Validate worker token and extract agentId
    let agentId: string | undefined;
    if (workerToken && !workerToken.startsWith("sk-ant-")) {
      // This is a worker token, not an Anthropic API key
      const { verifyWorkerToken } = await import("@peerbot/core");
      const tokenData = verifyWorkerToken(workerToken);

      if (!tokenData) {
        logger.warn("Invalid worker token received");
        return c.json(
          {
            error: {
              type: "authentication_error",
              message: "Invalid worker authentication token",
            },
          },
          401
        );
      }

      // Use agentId from token for credential lookup (fall back to userId for backwards compat)
      agentId = tokenData.agentId || tokenData.userId;
      logger.info(`Authenticated worker request for space: ${agentId}`);
    }

    // Resolve API key/token: space token > system token > error
    let apiKey: string | undefined;
    let tokenSource: "space" | "system" | "none" = "none";

    // Check for space credentials first
    if (agentId && this.credentialStore) {
      const credentials = await this.credentialStore.getCredentials(agentId);
      if (credentials) {
        // Check if token is expired (with 5 minute buffer)
        const expiryBuffer = 5 * 60 * 1000; // 5 minutes in milliseconds
        const isExpired = credentials.expiresAt <= Date.now() + expiryBuffer;

        if (isExpired) {
          logger.info(
            `Token expired for space ${agentId}, attempting refresh`,
            {
              expiresAt: new Date(credentials.expiresAt).toISOString(),
              now: new Date().toISOString(),
            }
          );

          // Attempt to refresh the token
          const refreshedToken = await this.refreshSpaceToken(agentId);
          if (refreshedToken) {
            apiKey = refreshedToken;
            tokenSource = "space";
            logger.info(`Using refreshed OAuth token for space ${agentId}`);
          } else {
            // Refresh failed - will fall back to system token or return error
            logger.warn(
              `Token refresh failed for space ${agentId}, falling back`
            );
          }
        } else {
          // Token is still valid
          apiKey = credentials.accessToken;
          tokenSource = "space";
          logger.info(`Using space OAuth token for ${agentId}`);
        }
      }
    }

    // Fall back to system token if no user token
    if (!apiKey && this.config.anthropicApiKey) {
      apiKey = this.config.anthropicApiKey;
      tokenSource = "system";
      logger.info(`Using system API key`);
    }

    // No credentials available - return error
    if (!apiKey) {
      logger.warn(`No API key available for request`, { agentId });
      return c.json(
        {
          error: {
            type: "authentication_error",
            message:
              "No Claude authentication configured. Please login via Slack home tab or configure ANTHROPIC_API_KEY environment variable.",
          },
        },
        401
      );
    }

    // Check if we're using OAuth token (sk-ant-oat01-) vs API key (sk-ant-api03-)
    const isOAuthToken = apiKey.startsWith("sk-ant-oat");

    const url = new URL(c.req.url);
    const path = url.pathname.replace(/^\/api\/anthropic/, "");
    const anthropicUrl = `${this.config.anthropicBaseUrl || "https://api.anthropic.com"}${path}`;

    // Add ?beta=true for OAuth tokens on /v1/messages
    let finalUrl = anthropicUrl;
    if (
      isOAuthToken &&
      path === "/v1/messages" &&
      !anthropicUrl.includes("beta=")
    ) {
      finalUrl += `${anthropicUrl.includes("?") ? "&" : "?"}beta=true`;
    }

    const headers: Record<string, string> = {};
    const method = c.req.method;
    let body: string | undefined;

    if (method !== "GET" && method !== "HEAD") {
      body = await c.req.text();
    }

    logger.info(
      `🔧 Original body type: ${typeof body}, length: ${body ? body.length : 0}`
    );

    if (isOAuthToken) {
      logger.info(
        `🔧 OAuth token detected - passthrough body (no tool override)`
      );

      // OAuth headers (Bearer, not x-api-key)
      headers.Authorization = `Bearer ${apiKey}`;
      headers["Content-Type"] = "application/json";
      headers.Accept = "application/json";
      headers["User-Agent"] = "claude-cli/1.0.98 (external, sdk-cli)";
      headers["anthropic-version"] = "2023-06-01";
      headers["anthropic-dangerous-direct-browser-access"] = "true";
      headers["x-app"] = "cli";
      headers["x-stainless-arch"] = "arm64";
      headers["x-stainless-lang"] = "js";
      headers["x-stainless-os"] = "MacOS";
      headers["x-stainless-package-version"] = "0.60.0";
      headers["x-stainless-retry-count"] = "0";
      headers["x-stainless-runtime"] = "node";
      headers["x-stainless-runtime-version"] = "v23.10.0";
      headers["x-stainless-timeout"] = "600";
      // Keep a stable beta header without mutating tools/body
      headers["anthropic-beta"] =
        "oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14";

      logger.info(
        `🔧 Using OAuth token with passthrough body (${tokenSource})`
      );
    } else {
      logger.info(
        `🔧 Using regular API key routing for public Anthropic API (${tokenSource})`
      );

      // Standard API headers for regular API keys
      headers["x-api-key"] = apiKey;
      headers["Content-Type"] =
        c.req.header("content-type") || "application/json";
      headers["User-Agent"] = c.req.header("user-agent") || "peerbot-proxy/1.0";

      // Forward additional headers that Anthropic might need
      const anthropicVersion = c.req.header("anthropic-version");
      if (anthropicVersion) {
        headers["anthropic-version"] = anthropicVersion;
      }
    }

    // Extract request metadata for logging
    let requestModel = "unknown";
    let requestMaxTokens = "unknown";
    let messageCount = 0;
    try {
      const parsedBody = body ? JSON.parse(body) : undefined;
      requestModel = parsedBody?.model || "unknown";
      requestMaxTokens =
        parsedBody?.max_tokens || parsedBody?.maxTokens || "default";
      messageCount = Array.isArray(parsedBody?.messages)
        ? parsedBody.messages.length
        : 0;
    } catch {
      // Ignore parsing errors for metadata
    }

    logger.info(
      `🔧 Forwarding to Anthropic API: ${finalUrl} - model: ${requestModel}, maxTokens: ${requestMaxTokens}, messages: ${messageCount}, tokenSource: ${tokenSource}`
    );
    const fetchStartTime = Date.now();

    try {
      const response = await fetch(finalUrl, {
        method,
        headers,
        body,
      });

      const fetchDuration = Date.now() - fetchStartTime;
      logger.info(
        `✅ Anthropic API response received (${fetchDuration}ms) - status: ${response.status}, model: ${requestModel}, isStream: ${response.headers.get("content-type")?.includes("text/event-stream") ? "yes" : "no"}`
      );

      // Temporary rate-limit bypass for local testing
      if (response.status === 429) {
        logger.warn(
          "Anthropic rate limited the request – surfacing error to user as assistant message"
        );

        let requestedModel: string | undefined;
        if (body) {
          try {
            requestedModel = JSON.parse(body)?.model;
          } catch {
            requestedModel = undefined;
          }
        }

        const errorPayloadText = await response.text();
        let anthropicMessage =
          "The model provider returned a rate limit error. Please try again shortly.";
        try {
          const parsedError = JSON.parse(errorPayloadText);
          anthropicMessage =
            parsedError?.error?.message ||
            parsedError?.message ||
            anthropicMessage;
        } catch {
          if (errorPayloadText) {
            anthropicMessage = errorPayloadText;
          }
        }

        const userFacingText = `⚠️ *Rate limit*\n\n${anthropicMessage}`;

        const rateLimitResponse = {
          id: `msg_rate_limit_${Date.now()}`,
          type: "message",
          role: "assistant" as const,
          content: [
            {
              type: "text" as const,
              text: userFacingText,
            },
          ],
          model: requestedModel ?? "claude-3-5-sonnet-20241022",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
          rate_limited: true,
        };

        return c.json(rateLimitResponse, 200);
      }

      // Build response headers
      const responseHeaders = new Headers();
      response.headers.forEach((value, key) => {
        // Skip certain headers that shouldn't be forwarded
        if (
          ![
            "transfer-encoding",
            "connection",
            "upgrade",
            "content-encoding",
          ].includes(key.toLowerCase())
        ) {
          responseHeaders.set(key, value);
        }
      });

      // Handle streaming responses
      if (
        response.headers.get("content-type")?.includes("text/event-stream") ||
        response.headers.get("transfer-encoding") === "chunked"
      ) {
        logger.info(
          `📡 Starting stream pipe to client - model: ${requestModel}`
        );
        responseHeaders.set("Cache-Control", "no-cache");
        responseHeaders.set("Connection", "keep-alive");

        if (response.body) {
          // Return the stream directly
          return new Response(response.body as ReadableStream, {
            status: response.status,
            headers: responseHeaders,
          });
        } else {
          logger.error(`❌ No response body to stream`);
          return c.json({ error: "No response body from Anthropic" }, 502);
        }
      } else {
        // Handle regular responses
        const responseText = await response.text();
        return new Response(responseText, {
          status: response.status,
          headers: responseHeaders,
        });
      }
    } catch (error) {
      logger.error("Error forwarding to Anthropic API:", error);
      return c.json(
        { error: "Bad gateway - failed to reach Anthropic API" },
        502
      );
    }
  }
}
