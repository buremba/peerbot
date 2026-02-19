import { BaseModule, createLogger, decrypt, encrypt } from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { GenericOAuth2Client } from "../oauth/generic-client";
import type { McpOAuthStateStore } from "../oauth/state-store";
import {
  formatMcpName,
  renderOAuthErrorPage,
  renderOAuthSuccessPage,
} from "../oauth-templates";
import type { McpConfigService } from "./config-service";
import type { McpCredentialStore } from "./credential-store";
import type { McpInputStore } from "./input-store";

const logger = createLogger("mcp-oauth-module");

interface McpStatus {
  id: string;
  name: string;
  isAuthenticated: boolean;
  authType: "oauth" | "discovered-oauth" | "inputs";
  metadata?: Record<string, unknown>;
  upstreamUrl: string;
}

/**
 * MCP OAuth Module - Handles OAuth authentication for MCP servers
 * Provides login/logout functionality via Slack home tab
 */
export class McpOAuthModule extends BaseModule {
  name = "mcp-oauth";
  private oauth2Client: GenericOAuth2Client;
  private publicGatewayUrl: string;
  private callbackUrl: string;
  private app: Hono;

  constructor(
    private configService: McpConfigService,
    private credentialStore: McpCredentialStore,
    private stateStore: McpOAuthStateStore,
    private inputStore: McpInputStore,
    publicGatewayUrl: string,
    callbackUrl: string
  ) {
    super();

    this.oauth2Client = new GenericOAuth2Client();
    this.publicGatewayUrl = publicGatewayUrl;
    this.callbackUrl = callbackUrl;
    this.app = new Hono();
    this.setupRoutes();
  }

  isEnabled(): boolean {
    // Always enabled if MCP config service is available
    return true;
  }

  /**
   * Get the Hono app
   */
  getApp(): Hono {
    return this.app;
  }

  /**
   * Generate a secure token for OAuth init URL
   * Token contains encrypted userId, agentId, mcpId, and expiry
   */
  private generateSecureToken(
    userId: string,
    agentId: string,
    mcpId: string
  ): string {
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
    const payload = JSON.stringify({ userId, agentId, mcpId, expiresAt });
    return encrypt(payload);
  }

  /**
   * Validate and decode a secure token
   * Returns { userId, agentId, mcpId } if valid, null if invalid or expired
   */
  private validateSecureToken(
    token: string
  ): { userId: string; agentId: string; mcpId: string } | null {
    try {
      const decrypted = decrypt(token);
      const data = JSON.parse(decrypted);
      const { userId, agentId, mcpId, expiresAt } = data;

      // Check expiry
      if (Date.now() > expiresAt) {
        logger.warn("Token expired", { userId, agentId, mcpId });
        return null;
      }

      return { userId, agentId, mcpId };
    } catch (error) {
      logger.error("Failed to validate token", { error });
      return null;
    }
  }

  /**
   * Setup OAuth routes on Hono app
   */
  private setupRoutes(): void {
    // Initialize OAuth flow
    this.app.get("/init/:mcpId", (c) => this.handleOAuthInit(c));

    // OAuth callback endpoint
    this.app.get("/callback", (c) => this.handleOAuthCallback(c));

    // Logout endpoint
    this.app.post("/logout/:mcpId", (c) => this.handleLogout(c));

    logger.info("MCP OAuth routes configured");
  }

  /**
   * Register OAuth endpoints (for backward compatibility with module system)
   */
  registerEndpoints(_app: any): void {
    // Routes are already registered in constructor via setupRoutes()
    // This method is kept for module interface compatibility
    logger.info("MCP OAuth endpoints registered via module system");
  }

  /**
   * Get platform-agnostic authentication status for all MCP servers
   * Returns abstract provider data that can be rendered by any platform adapter
   */
  async getAuthStatus(
    userId: string,
    agentId: string
  ): Promise<
    Array<{
      id: string;
      name: string;
      isAuthenticated: boolean;
      loginUrl?: string;
      logoutUrl?: string;
      metadata?: Record<string, any>;
    }>
  > {
    try {
      const mcpStatuses = await this.getMcpStatuses(agentId);

      return mcpStatuses.map((mcp) => {
        const provider: {
          id: string;
          name: string;
          isAuthenticated: boolean;
          loginUrl?: string;
          logoutUrl?: string;
          metadata?: Record<string, any>;
        } = {
          id: mcp.id,
          name: mcp.name,
          isAuthenticated: mcp.isAuthenticated,
          metadata: {
            authType: mcp.authType,
            upstreamUrl: mcp.upstreamUrl,
            ...mcp.metadata,
          },
        };

        // Add login URL for OAuth-based MCPs
        if (
          !mcp.isAuthenticated &&
          (mcp.authType === "oauth" || mcp.authType === "discovered-oauth")
        ) {
          const token = this.generateSecureToken(userId, agentId, mcp.id);
          provider.loginUrl = `${this.publicGatewayUrl}/api/v1/auth/mcp/init/${mcp.id}?token=${encodeURIComponent(token)}`;
        }

        return provider;
      });
    } catch (error) {
      logger.error("Failed to get MCP auth status", { error, userId, agentId });
      return [];
    }
  }

  /**
   * Handle home tab action (login/logout/configure buttons)
   */
  async handleAction(
    actionId: string,
    userId: string,
    context: any
  ): Promise<boolean> {
    const agentId = context.agentId;
    if (!agentId) {
      logger.error("Missing agentId in action context", { actionId, userId });
      return false;
    }

    // Handle configure button (inputs)
    if (actionId.startsWith("mcp_configure_")) {
      const mcpId = actionId.replace("mcp_configure_", "");

      try {
        const httpServer = await this.configService.getHttpServer(
          mcpId,
          agentId
        );
        if (
          !httpServer ||
          !httpServer.inputs ||
          httpServer.inputs.length === 0
        ) {
          logger.error(`MCP ${mcpId} not found or has no inputs`);
          return false;
        }

        // Build modal with input fields (include agentId in metadata)
        const modal = this.buildInputModal(mcpId, agentId, httpServer.inputs);

        // Open modal
        if (context.client && context.body?.trigger_id) {
          await context.client.views.open({
            trigger_id: context.body.trigger_id,
            view: modal,
          });
        }

        logger.info(
          `Opened input modal for user ${userId}, space ${agentId}, MCP ${mcpId}`
        );
        return true;
      } catch (error) {
        logger.error("Failed to handle configure action", {
          error,
          mcpId,
          userId,
          agentId,
        });
        return false;
      }
    }

    // Handle logout/clear button
    if (actionId.startsWith("mcp_logout_")) {
      const mcpId = actionId.replace("mcp_logout_", "");

      // Delete both OAuth credentials and input values
      await this.credentialStore.deleteCredentials(agentId, mcpId);
      await this.inputStore.deleteInputs(agentId, mcpId);

      logger.info(`Space ${agentId} logged out/cleared from ${mcpId}`);

      // Update home tab
      if (context.updateAppHome) {
        await context.updateAppHome(userId, context.client);
      }

      return true;
    }

    return false;
  }

  /**
   * Handle view submission (modal submitted)
   */
  async handleViewSubmission(
    _viewId: string,
    userId: string,
    values: any,
    privateMetadata: string
  ): Promise<void> {
    try {
      // Parse metadata to get mcpId and agentId
      const metadata = JSON.parse(privateMetadata);
      const { mcpId, agentId } = metadata;

      if (!mcpId || !agentId) {
        logger.error("Missing mcpId or agentId in modal metadata", {
          metadata,
        });
        return;
      }

      // Extract input values from modal submission
      const inputValues: Record<string, string> = {};
      for (const [blockId, block] of Object.entries(values)) {
        const actionIds = Object.keys(block as any);
        if (actionIds.length > 0 && actionIds[0]) {
          const actionId: string = actionIds[0];
          const value = (block as any)[actionId]?.value;
          if (value) {
            inputValues[blockId] = value;
          }
        }
      }

      // Store input values using agentId
      await this.inputStore.setInputs(agentId, mcpId, inputValues);
      logger.info(`Stored input values for space ${agentId}, MCP ${mcpId}`);
    } catch (error) {
      logger.error("Failed to handle view submission", { error, userId });
      throw error;
    }
  }

  /**
   * Build Slack modal for collecting input values
   */
  private buildInputModal(mcpId: string, agentId: string, inputs: any[]): any {
    const blocks: any[] = [];

    // Add input blocks for each required input
    for (const input of inputs) {
      blocks.push({
        type: "input",
        block_id: input.id,
        label: {
          type: "plain_text",
          text: input.description || input.id,
        },
        element: {
          type: "plain_text_input",
          action_id: input.id,
          placeholder: {
            type: "plain_text",
            text: `Enter ${input.description || input.id}`,
          },
        },
      });
    }

    return {
      type: "modal",
      callback_id: `mcp_input_modal_${mcpId}`,
      private_metadata: JSON.stringify({ mcpId, agentId }),
      title: {
        type: "plain_text",
        text: `Configure ${formatMcpName(mcpId)}`,
      },
      submit: {
        type: "plain_text",
        text: "Save",
      },
      close: {
        type: "plain_text",
        text: "Cancel",
      },
      blocks,
    };
  }

  /**
   * Get status of all configured MCP servers for a space
   */
  private async getMcpStatuses(agentId: string): Promise<McpStatus[]> {
    const httpServers = await this.configService.getAllHttpServers(agentId);
    logger.info(
      `getMcpStatuses: Found ${httpServers.size} HTTP servers for space ${agentId}`
    );

    const statuses: McpStatus[] = [];

    for (const [id, serverConfig] of httpServers) {
      logger.debug(`Checking MCP ${id} for status`);

      // Support OAuth, discovered OAuth, and input-based authentication
      const hasOAuth = !!serverConfig.oauth;
      const hasInputs = !!(
        serverConfig.inputs && serverConfig.inputs.length > 0
      );

      // Check for discovered OAuth
      const discoveredOAuth = await this.configService.getDiscoveredOAuth(id);
      const hasDiscoveredOAuth = !!discoveredOAuth;

      logger.info(
        `MCP ${id}: hasOAuth=${hasOAuth}, hasInputs=${hasInputs}, hasDiscoveredOAuth=${hasDiscoveredOAuth}`
      );

      // Skip MCPs without any authentication method
      if (!hasOAuth && !hasInputs && !hasDiscoveredOAuth) {
        logger.debug(`Skipping MCP ${id} - no auth method configured`);
        continue;
      }

      let isAuthenticated = false;
      let metadata: Record<string, unknown> | undefined;
      let authType: "oauth" | "discovered-oauth" | "inputs";

      if (hasOAuth || hasDiscoveredOAuth) {
        // Check OAuth credentials (works for static and discovered OAuth)
        authType = hasOAuth ? "oauth" : "discovered-oauth";
        const credentials = await this.credentialStore.getCredentials(
          agentId,
          id
        );
        // Show as authenticated if credentials exist, even if expired
        // Auto-refresh will handle expired tokens when MCP is used
        isAuthenticated = !!credentials?.accessToken;
        metadata = credentials?.metadata;
      } else {
        // Input-based authentication
        authType = "inputs";
        const inputValues = await this.inputStore.getInputs(agentId, id);
        isAuthenticated = !!inputValues;
      }

      statuses.push({
        id,
        name: formatMcpName(id),
        isAuthenticated,
        authType,
        metadata,
        upstreamUrl: serverConfig.upstreamUrl,
      });
    }

    return statuses;
  }

  /**
   * Handle OAuth initialization - redirect user to MCP login
   */
  private async handleOAuthInit(c: Context): Promise<Response> {
    const mcpId = c.req.param("mcpId");
    const token = c.req.query("token");

    if (!token) {
      return c.json({ error: "Missing token parameter" }, 400);
    }

    if (!mcpId) {
      return c.json({ error: "Missing mcpId parameter" }, 400);
    }

    // Validate and decode token
    const tokenData = this.validateSecureToken(token);
    if (!tokenData) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    // Verify mcpId matches token
    if (tokenData.mcpId !== mcpId) {
      return c.json({ error: "Token mcpId mismatch" }, 400);
    }

    const { userId, agentId } = tokenData;

    try {
      // Get MCP config
      const httpServer = await this.configService.getHttpServer(mcpId, agentId);
      if (!httpServer) {
        return c.json({ error: "MCP not found" }, 404);
      }

      let oauthConfig = httpServer.oauth;

      // If no static OAuth config, check for discovered OAuth
      if (!oauthConfig) {
        const discoveredOAuth =
          await this.configService.getDiscoveredOAuth(mcpId);
        if (discoveredOAuth?.metadata) {
          logger.info(
            `Using discovered OAuth for ${mcpId} from ${discoveredOAuth.metadata.issuer}`
          );

          // Get or create client credentials via dynamic registration
          const discoveryService = this.configService.getDiscoveryService();
          if (!discoveryService) {
            return c.json(
              { error: "OAuth discovery service not available" },
              500
            );
          }

          const clientCredentials =
            await discoveryService.getOrCreateClientCredentials(
              mcpId,
              discoveredOAuth.metadata
            );

          if (!clientCredentials?.client_id) {
            // Check if MCP supports dynamic registration
            const hasRegistrationEndpoint =
              !!discoveredOAuth.metadata.registration_endpoint;

            if (!hasRegistrationEndpoint) {
              logger.warn(
                `MCP ${mcpId} does not support dynamic client registration (RFC 7591)`
              );
              return c.json(
                {
                  error: `${formatMcpName(mcpId)} requires manual OAuth app setup`,
                  details: `This MCP does not support automatic client registration. Please:
1. Create an OAuth app at the provider's website
2. Configure the OAuth client ID and secret in your MCP configuration
3. Add the callback URL: ${this.callbackUrl}`,
                },
                400
              );
            } else {
              logger.error(
                `Failed to register OAuth client for ${mcpId} despite having registration endpoint`
              );
              return c.json(
                {
                  error: "Failed to register OAuth client for this MCP",
                  details:
                    "Dynamic registration failed. Check server logs for details.",
                },
                400
              );
            }
          }

          logger.info(`Using client credentials for ${mcpId}`, {
            client_id: clientCredentials.client_id,
            has_secret: !!clientCredentials.client_secret,
          });

          // Build OAuth config from discovered metadata
          // If no client_secret (PKCE flow), set to empty string
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
        } else {
          return c.json({ error: "MCP has no OAuth configuration" }, 404);
        }
      }

      // Check if we have valid OAuth config
      if (!oauthConfig) {
        return c.json(
          { error: "No OAuth configuration available for this MCP" },
          400
        );
      }

      // Generate and store state (include agentId for credential storage)
      const state = await this.stateStore.createWithNonce({
        userId,
        agentId,
        mcpId,
      });

      // Build OAuth URL
      const loginUrl = this.oauth2Client.buildAuthUrl(
        oauthConfig,
        state,
        this.callbackUrl
      );

      // Redirect to OAuth provider
      logger.info(
        `Initiated OAuth for user ${userId}, space ${agentId}, MCP ${mcpId}`
      );
      return c.redirect(loginUrl);
    } catch (error) {
      logger.error("Failed to init OAuth", { error, mcpId, userId });
      return c.json({ error: "Failed to initialize OAuth" }, 500);
    }
  }

  /**
   * Handle OAuth callback - exchange code for token and store credentials
   */
  private async handleOAuthCallback(c: Context): Promise<Response> {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");
    const error_description = c.req.query("error_description");

    // Handle OAuth errors (user denied, etc.)
    if (error) {
      logger.warn(`OAuth error: ${error}`, { error_description });
      return c.html(renderOAuthErrorPage(error, error_description || ""));
    }

    if (!code || !state) {
      return c.html(
        renderOAuthErrorPage("invalid_request", "Missing code or state"),
        400
      );
    }

    try {
      // Validate and consume state
      const stateData = await this.stateStore.consume(state);
      if (!stateData) {
        return c.html(
          renderOAuthErrorPage(
            "invalid_state",
            "Invalid or expired state parameter"
          ),
          400
        );
      }

      // Get MCP config for token exchange
      const httpServer = await this.configService.getHttpServer(
        stateData.mcpId,
        stateData.agentId
      );
      if (!httpServer) {
        return c.html(
          renderOAuthErrorPage("mcp_not_found", "MCP server not found"),
          404
        );
      }

      // Exchange code for token
      let credentials;
      let oauthConfig = httpServer.oauth;

      // If no static OAuth config, check for discovered OAuth
      if (!oauthConfig) {
        const discoveredOAuth = await this.configService.getDiscoveredOAuth(
          stateData.mcpId
        );
        if (discoveredOAuth?.metadata) {
          logger.info(
            `Using discovered OAuth for ${stateData.mcpId} from ${discoveredOAuth.metadata.issuer}`
          );

          // Get or create client credentials via dynamic registration
          const discoveryService = this.configService.getDiscoveryService();
          if (discoveryService) {
            const clientCredentials =
              await discoveryService.getOrCreateClientCredentials(
                stateData.mcpId,
                discoveredOAuth.metadata
              );

            if (clientCredentials?.client_id) {
              logger.info(`Using client credentials for ${stateData.mcpId}`, {
                client_id: clientCredentials.client_id,
                has_secret: !!clientCredentials.client_secret,
              });

              // Build OAuth config from discovered metadata
              // If no client_secret (PKCE flow), set to empty string
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
          }
        }
      }

      if (oauthConfig) {
        // Full OAuth2 token exchange
        credentials = await this.oauth2Client.exchangeCodeForToken(
          code,
          oauthConfig,
          this.callbackUrl
        );
      } else {
        // Fallback: use code as token (for simple cases)
        logger.warn(
          `MCP ${stateData.mcpId} has no oauth config, using code as token`
        );
        credentials = {
          accessToken: code,
          tokenType: "Bearer",
          expiresAt: Date.now() + 3600000, // 1 hour default
          metadata: {
            grantedAt: new Date().toISOString(),
          },
        };
      }

      // Store credentials without TTL to preserve refresh token
      // Even if access token expires, we keep credentials so we can refresh
      await this.credentialStore.setCredentials(
        stateData.agentId,
        stateData.mcpId,
        credentials
      );

      logger.info(
        `OAuth successful for space ${stateData.agentId}, MCP ${stateData.mcpId}`
      );

      // Show success page
      return c.html(renderOAuthSuccessPage(formatMcpName(stateData.mcpId)));
    } catch (error) {
      logger.error("Failed to handle OAuth callback", {
        error,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      });
      return c.html(
        renderOAuthErrorPage(
          "server_error",
          "Failed to complete authentication"
        ),
        500
      );
    }
  }

  /**
   * Handle logout - delete credentials
   */
  private async handleLogout(c: Context): Promise<Response> {
    const mcpId = c.req.param("mcpId");
    let agentId: string | undefined;

    // Try to get agentId from body or query
    try {
      const body = await c.req.json().catch(() => ({}));
      agentId = body.agentId || c.req.query("agentId");
    } catch {
      agentId = c.req.query("agentId");
    }

    if (!agentId) {
      return c.json({ error: "Missing agentId" }, 400);
    }

    try {
      await this.credentialStore.deleteCredentials(agentId, mcpId!);
      logger.info(`Space ${agentId} logged out from ${mcpId}`);
      return c.json({ success: true });
    } catch (error) {
      logger.error("Failed to logout", { error, mcpId, agentId });
      return c.json({ error: "Failed to logout" }, 500);
    }
  }
}
