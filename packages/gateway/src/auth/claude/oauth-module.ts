import {
  BaseModule,
  createLogger,
  decrypt,
  type ModelOption,
  type ModelProviderModule,
} from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import type { IMessageQueue } from "../../infrastructure/queue";
import { ClaudeOAuthClient } from "../oauth/claude-client";
import type { ClaudeOAuthStateStore } from "../oauth/state-store";
import {
  renderOAuthErrorPage,
  renderOAuthSuccessPage,
} from "../oauth-templates";
import type { ClaudeCredentialStore } from "./credential-store";
import type { ClaudeModelPreferenceStore } from "./model-preference-store";

const logger = createLogger("claude-oauth-module");

/**
 * Claude OAuth Module - Handles OAuth authentication for Claude
 * Provides login/logout functionality via Slack home tab
 * Also injects user OAuth tokens and model preferences into worker deployments
 */
export class ClaudeOAuthModule
  extends BaseModule
  implements ModelProviderModule
{
  name = "claude-oauth";
  providerId = "claude";
  providerDisplayName = "Claude AI";
  providerIconUrl = "https://www.anthropic.com/favicon.ico";
  authType = "oauth" as const;
  private oauthClient: ClaudeOAuthClient;
  private publicGatewayUrl: string;
  private queue: IMessageQueue;
  private app: Hono;

  constructor(
    private credentialStore: ClaudeCredentialStore,
    private stateStore: ClaudeOAuthStateStore,
    private modelPreferenceStore: ClaudeModelPreferenceStore,
    queue: IMessageQueue,
    publicGatewayUrl: string
  ) {
    super();

    this.oauthClient = new ClaudeOAuthClient();
    this.queue = queue;
    this.publicGatewayUrl = publicGatewayUrl;
    this.app = new Hono();
    this.setupRoutes();
  }

  isEnabled(): boolean {
    // Always enabled - we show model selection even with system token
    return true;
  }

  // ---- ModelProviderModule methods ----

  getSecretEnvVarNames(): string[] {
    return [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ];
  }

  async hasCredentials(agentId: string): Promise<boolean> {
    return this.credentialStore.hasCredentials(agentId);
  }

  hasSystemKey(): boolean {
    return !!(
      process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN
    );
  }

  getProxyBaseUrlMappings(proxyUrl: string): Record<string, string> {
    return { ANTHROPIC_BASE_URL: proxyUrl };
  }

  injectSystemKeyFallback(
    envVars: Record<string, string>
  ): Record<string, string> {
    if (!envVars.ANTHROPIC_API_KEY && !envVars.CLAUDE_CODE_OAUTH_TOKEN) {
      const systemApiKey =
        process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
      const systemOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

      if (systemApiKey) {
        envVars.ANTHROPIC_API_KEY = systemApiKey;
      } else if (systemOAuthToken) {
        envVars.CLAUDE_CODE_OAUTH_TOKEN = systemOAuthToken;
      }
    }
    return envVars;
  }

  /**
   * Get the Hono app
   */
  getApp(): Hono {
    return this.app;
  }

  /**
   * Build environment variables for worker deployment
   * Injects space's Claude OAuth token and user's model preference if available
   */
  async buildEnvVars(
    userId: string,
    agentId: string,
    envVars: Record<string, string>
  ): Promise<Record<string, string>> {
    // Try to get space's credentials
    const credentials = await this.credentialStore.getCredentials(agentId);

    if (credentials) {
      // Space has OAuth credentials - use their token
      logger.info(`Injecting OAuth token for space ${agentId}`);
      envVars.CLAUDE_CODE_OAUTH_TOKEN = credentials.accessToken;
    } else {
      logger.debug(`No credentials for space ${agentId}, using system token`);
      // System token (if any) will already be in envVars from base deployment
    }

    // Inject user's model preference if set (still user-scoped)
    const modelPreference =
      await this.modelPreferenceStore.getModelPreference(userId);
    if (modelPreference) {
      logger.info(
        `Injecting model preference for ${userId}: ${modelPreference}`
      );
      envVars.AGENT_DEFAULT_MODEL = modelPreference;
    }

    return envVars;
  }

  async getModelOptions(
    agentId: string,
    userId: string
  ): Promise<ModelOption[]> {
    const [availableModels, preferredModel, hasSpaceCredentials] =
      await Promise.all([
        this.modelPreferenceStore.getAvailableModels(),
        this.modelPreferenceStore.getModelPreference(userId),
        this.credentialStore.hasCredentials(agentId),
      ]);
    logger.debug("Building Claude model options", {
      agentId,
      userId,
      preferredModel,
      hasSpaceCredentials,
    });
    const defaultModel =
      preferredModel ||
      process.env.AGENT_DEFAULT_MODEL ||
      "claude-sonnet-4-20250514";
    const options: ModelOption[] = [];
    const seen = new Set<string>();

    const addOption = (value: string, label: string) => {
      if (seen.has(value)) return;
      seen.add(value);
      options.push({ value, label });
    };

    const defaultEntry = availableModels.find((m) => m.id === defaultModel);
    addOption(
      defaultModel,
      defaultEntry?.display_name ||
        `Claude ${defaultModel.replace(/^claude-/, "")}`
    );

    for (const model of availableModels) {
      addOption(model.id, model.display_name || model.id);
    }

    return options;
  }

  /**
   * Validate and decode the secure token generated for OAuth init links
   * Returns the userId and agentId if valid, null otherwise
   */
  private validateSecureToken(
    token: string
  ): { userId: string; agentId: string } | null {
    try {
      const decrypted = decrypt(token);
      const data = JSON.parse(decrypted) as {
        userId?: string;
        agentId?: string;
        expiresAt?: number;
      };

      if (!data.userId || !data.agentId || !data.expiresAt) {
        logger.warn("Token missing required fields");
        return null;
      }

      if (Date.now() > data.expiresAt) {
        logger.warn("Token expired", {
          userId: data.userId,
          agentId: data.agentId,
        });
        return null;
      }

      return { userId: data.userId, agentId: data.agentId };
    } catch (error) {
      logger.error("Failed to validate secure token", { error });
      return null;
    }
  }

  /**
   * Setup OAuth routes on Hono app
   */
  private setupRoutes(): void {
    // Initialize OAuth flow
    this.app.get("/init", (c) => this.handleOAuthInit(c));

    // OAuth callback endpoint
    this.app.get("/callback", (c) => this.handleOAuthCallback(c));

    // Logout endpoint
    this.app.post("/logout", (c) => this.handleLogout(c));

    logger.info("Claude OAuth routes configured");
  }

  /**
   * Register OAuth endpoints (for backward compatibility with module system)
   */
  registerEndpoints(_app: any): void {
    // Routes are already registered in constructor via setupRoutes()
    // This method is kept for module interface compatibility
    logger.info("Claude OAuth endpoints registered via module system");
  }

  /**
   * Get platform-agnostic authentication status for Claude
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
      const hasCredentials = await this.credentialStore.hasCredentials(agentId);
      const availableModels =
        await this.modelPreferenceStore.getAvailableModels();
      const currentModel =
        await this.modelPreferenceStore.getModelPreference(userId);

      const isAuthenticated = hasCredentials || this.hasSystemKey();

      // Only show login/logout if no system token (users manage their own auth)
      let loginUrl: string | undefined;
      let logoutUrl: string | undefined;

      if (!this.hasSystemKey()) {
        if (!hasCredentials) {
          // Not authenticated - provide login action
          // We use action_id pattern for Slack button actions
          loginUrl = "action:claude_auth_start";
        } else {
          // Authenticated - provide logout action
          logoutUrl = "action:claude_logout";
        }
      }

      return [
        {
          id: "claude",
          name: "Claude AI",
          isAuthenticated,
          loginUrl,
          logoutUrl,
          metadata: {
            availableModels,
            currentModel,
            systemTokenAvailable: this.hasSystemKey(),
          },
        },
      ];
    } catch (error) {
      logger.error("Failed to get Claude auth status", { error, userId });
      return [];
    }
  }

  /**
   * Handle home tab action (logout button, model selection, and auth modal)
   */
  async handleAction(
    actionId: string,
    userId: string,
    agentId: string,
    context: any
  ): Promise<boolean> {
    if (actionId === "claude_logout") {
      await this.credentialStore.deleteCredentials(agentId);
      logger.info(`Space ${agentId} logged out from Claude`);

      // Update home tab
      if (context.updateAppHome) {
        await context.updateAppHome(userId, context.client);
      }

      return true;
    }

    if (actionId === "claude_select_model") {
      // Get selected model from action body
      const selectedValue = context.body?.actions?.[0]?.selected_option?.value;
      if (selectedValue) {
        await this.modelPreferenceStore.setModelPreference(
          userId,
          selectedValue
        );
        logger.info(`User ${userId} selected model: ${selectedValue}`);

        // Update home tab to reflect the change
        if (context.updateAppHome) {
          await context.updateAppHome(userId, context.client);
        }
      }

      return true;
    }

    if (actionId === "claude_auth_start") {
      // Open modal with Claude OAuth URL and auth code input
      // Generate PKCE code verifier
      const codeVerifier = this.oauthClient.generateCodeVerifier();

      // Generate OAuth state for CSRF protection and store with code verifier
      const state = await this.stateStore.create({
        userId,
        agentId,
        codeVerifier,
      });

      // Build Claude OAuth URL that redirects to console.anthropic.com callback
      const authUrl = this.oauthClient.buildAuthUrl(
        state,
        codeVerifier,
        "https://console.anthropic.com/oauth/code/callback"
      );

      // Detect context - where was the button clicked?
      // For ephemeral messages, Slack doesn't include the message object
      // We need to check the action body structure
      const body = context.body as any;

      // Check if it's from home tab (has view field) or from a message
      const isHomeTab = !!body.view;

      // For ephemeral messages in threads, the container has thread_ts
      const container = body.container;
      const message = body.message;

      let threadTs: string | undefined;

      if (container) {
        // Ephemeral message - use container.thread_ts if in a thread
        threadTs = container.thread_ts || container.message_ts;
      } else if (message) {
        // Regular message - use thread_ts or ts
        threadTs = message.thread_ts || message.ts;
      }

      const loginContext = {
        state,
        source: isHomeTab ? "home_tab" : "ephemeral_message",
        platform: "slack",
        channelId: context.channelId,
        teamId: context.teamId,
        messageTs: threadTs,
      };

      try {
        await context.client.views.open({
          trigger_id: context.body.trigger_id,
          view: {
            type: "modal",
            callback_id: "claude_auth_submit",
            private_metadata: JSON.stringify(loginContext), // Pass context through modal
            title: {
              type: "plain_text",
              text: "Login to Claude",
            },
            submit: {
              type: "plain_text",
              text: "Submit",
            },
            close: {
              type: "plain_text",
              text: "Cancel",
            },
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*Step 1:* Click the link below to authorize with Claude:\n\n<${authUrl}|🔗 Login with Claude>`,
                },
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "*Step 2:* After authorizing, you'll see an authentication code.",
                },
              },
              {
                type: "input",
                block_id: "auth_code_block",
                element: {
                  type: "plain_text_input",
                  action_id: "auth_code_input",
                  placeholder: {
                    type: "plain_text",
                    text: "abc123...#xyz789...",
                  },
                },
                label: {
                  type: "plain_text",
                  text: "Authentication Code",
                },
              },
            ],
          },
        });

        logger.info(`Opened auth modal for user ${userId} with state ${state}`);
      } catch (error) {
        logger.error("Failed to open auth modal", { error, userId });
      }

      return true;
    }

    return false;
  }

  /**
   * Handle modal submission for authorization code
   */
  async handleViewSubmission(
    _viewId: string,
    userId: string,
    values: any,
    privateMetadata: string
  ): Promise<void> {
    const input = values?.auth_code_block?.auth_code_input?.value?.trim();

    if (!input) {
      logger.warn("No input provided", { userId });
      throw new Error("Authentication code is required");
    }

    // Parse the authentication code
    // Expected format: CODE#STATE (e.g., NdaqposxAuKMWyGKRfjZ9C00hg7VG3z1GI8XCMxPKSgHnz70#uwXkLAjz2C3AXHGKqZfVsHx-Syr6XuNWyRoZ1R70ikA)
    let authCode: string;
    let state: string;

    try {
      // Check if it's a URL format (for backward compatibility)
      if (input.startsWith("http://") || input.startsWith("https://")) {
        const url = new URL(input);
        authCode = url.searchParams.get("code") || "";
        state = url.hash.substring(1); // Remove the # prefix
      } else {
        // Parse CODE#STATE format
        const parts = input.split("#");
        if (parts.length !== 2) {
          throw new Error("Invalid format - expected CODE#STATE");
        }
        authCode = parts[0].trim();
        state = parts[1].trim();
      }

      if (!authCode || !state) {
        throw new Error("Missing code or state");
      }

      logger.info(`Parsed authentication code`, {
        userId,
        hasCode: !!authCode,
        hasState: !!state,
      });
    } catch (parseError) {
      logger.error("Failed to parse authentication code", {
        userId,
        input,
        error: parseError,
      });
      throw new Error(
        "Invalid format. Please paste the entire authentication code (CODE#STATE) from Claude."
      );
    }

    // Retrieve and consume the OAuth state to get code verifier
    const stateData = await this.stateStore.consume(state);
    if (!stateData) {
      logger.error("Failed to retrieve OAuth state", { userId, state });
      throw new Error("Invalid or expired authentication state");
    }

    try {
      logger.info(`Processing authorization code for user ${userId}`);

      // Exchange auth code for tokens using console.anthropic.com callback
      const credentials = await this.oauthClient.exchangeCodeForToken(
        authCode,
        stateData.codeVerifier,
        "https://console.anthropic.com/oauth/code/callback",
        state
      );

      // Store credentials using agentId for multi-tenant isolation
      await this.credentialStore.setCredentials(stateData.agentId, credentials);
      logger.info(`OAuth successful for space ${stateData.agentId} via modal`);

      // Parse login context to determine where to send success message
      let loginContext: any = { source: "home_tab" };
      try {
        loginContext = JSON.parse(privateMetadata || "{}");
      } catch {
        logger.warn(`Failed to parse private metadata: ${privateMetadata}`);
      }

      // Send success message based on context
      await this.sendSuccessMessage(userId, loginContext);
    } catch (error) {
      logger.error("Failed to process auth code", { error, userId });
      throw error;
    }
  }

  /**
   * Send success message after successful authentication
   */
  private async sendSuccessMessage(
    userId: string,
    loginContext: any
  ): Promise<void> {
    const source = loginContext.source || "home_tab";
    let message: string;

    if (source === "ephemeral_message") {
      // User clicked login from ephemeral message in DM
      message =
        "✅ *Login Successful!*\n\nYou're now authenticated with Claude. Please send your message again to process it.";
    } else {
      // User clicked login from home tab
      message =
        "✅ *Login Successful!*\n\nYou're now authenticated with Claude. You can start chatting with the bot!";
    }

    // Create thread_response queue if it doesn't exist
    await this.queue.createQueue("thread_response");

    // Send ephemeral success message
    await this.queue.send("thread_response", {
      messageId: `auth_success_${Date.now()}`,
      userId,
      channelId: loginContext.channelId || userId, // Use DM channel if no channelId
      conversationId: loginContext.messageTs || "",
      platform: loginContext.platform || "slack",
      teamId: loginContext.teamId || "slack",
      ephemeral: true,
      content: message,
      processedMessageIds: [`auth_success_${Date.now()}`],
    });

    logger.info(`Sent success message to user ${userId} via ${source}`);
  }

  /**
   * Handle OAuth initialization - redirect user to Claude login
   */
  private async handleOAuthInit(c: Context): Promise<Response> {
    const token = c.req.query("token");

    if (!token) {
      return c.json({ error: "Missing token parameter" }, 400);
    }

    // Validate and decode token
    const tokenData = this.validateSecureToken(token);
    if (!tokenData) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    const { userId, agentId } = tokenData;

    try {
      // Generate PKCE code verifier
      const codeVerifier = this.oauthClient.generateCodeVerifier();

      // Store state with code verifier and agentId
      const state = await this.stateStore.create({
        userId,
        agentId,
        codeVerifier,
      });

      // Build authorization URL
      const callbackUrl = `${this.publicGatewayUrl}/api/v1/auth/claude/callback`;
      const authUrl = this.oauthClient.buildAuthUrl(
        state,
        codeVerifier,
        callbackUrl
      );

      // Redirect to Claude OAuth
      logger.info(`Initiated OAuth for space ${agentId}`);
      return c.redirect(authUrl);
    } catch (error) {
      logger.error("Failed to init OAuth", { error, agentId });
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

      // Exchange code for token using PKCE
      const callbackUrl = `${this.publicGatewayUrl}/api/v1/auth/claude/callback`;
      const credentials = await this.oauthClient.exchangeCodeForToken(
        code,
        stateData.codeVerifier,
        callbackUrl
      );

      // Store credentials using agentId for multi-tenant isolation
      await this.credentialStore.setCredentials(stateData.agentId, credentials);

      logger.info(`OAuth successful for space ${stateData.agentId}`);

      // Show success page
      return c.html(renderOAuthSuccessPage("Claude"));
    } catch (error) {
      logger.error("Failed to handle OAuth callback", { error });
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
      await this.credentialStore.deleteCredentials(agentId);
      logger.info(`Space ${agentId} logged out from Claude`);
      return c.json({ success: true });
    } catch (error) {
      logger.error("Failed to logout", { error, agentId });
      return c.json({ error: "Failed to logout" }, 500);
    }
  }
}
