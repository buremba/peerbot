/**
 * Settings Routes - Agent configuration via magic link
 *
 * Routes:
 * - GET /settings - Render settings page (validates token)
 * - GET /api/v1/settings - Get current settings (validates token)
 * - POST /api/v1/settings - Save settings (validates token)
 * - GET /api/v1/settings/providers - Get provider connection status
 * - GET /api/v1/settings/providers/:provider/login - Initiate OAuth flow
 * - POST /api/v1/settings/providers/:provider/logout - Disconnect provider
 */

import { createLogger, type SkillConfig } from "@peerbot/core";
import { Hono } from "hono";
import type { ClaudeOAuthStateStore } from "../../auth/claude/oauth-state-store";
import type { AgentSettings, AgentSettingsStore } from "../../auth/settings";
import { verifySettingsToken } from "../../auth/settings/token-service";
import type { GitHubAppAuth } from "../../modules/git-filesystem/github-app";
import type { ScheduledWakeupService } from "../../orchestration/scheduled-wakeup";
import { SkillsFetcherService } from "../../services/skills-fetcher";
import { renderErrorPage, renderSettingsPage } from "./settings-page";

const logger = createLogger("settings-routes");

/**
 * Generic provider credential store interface
 */
export interface ProviderCredentialStore {
  hasCredentials(agentId: string): Promise<boolean>;
  deleteCredentials(agentId: string): Promise<void>;
  setCredentials(agentId: string, credentials: any): Promise<void>;
}

/**
 * OAuth client interface for initiating OAuth flows
 */
export interface ProviderOAuthClient {
  generateCodeVerifier(): string;
  buildAuthUrl(state: string, codeVerifier: string): string;
  exchangeCodeForToken(
    code: string,
    codeVerifier: string,
    redirectUri?: string,
    state?: string
  ): Promise<any>;
}

export interface SettingsRoutesConfig {
  agentSettingsStore: AgentSettingsStore;
  // Optional: provider stores keyed by provider name (defaults to claude only)
  providerStores?: Record<string, ProviderCredentialStore>;
  // Optional: OAuth clients keyed by provider name
  oauthClients?: Record<string, ProviderOAuthClient>;
  // Required for OAuth: state store
  oauthStateStore?: ClaudeOAuthStateStore;
  // Optional: GitHub App auth for repo selection
  githubAuth?: GitHubAppAuth;
  // Optional: URL to install the GitHub App
  githubAppInstallUrl?: string;
  // Optional: Scheduled wakeup service for viewing/cancelling reminders
  scheduledWakeupService?: ScheduledWakeupService;
  // Optional: GitHub OAuth for user identification (filters installations)
  githubOAuthClientId?: string;
  githubOAuthClientSecret?: string;
  // Optional: Public gateway URL for OAuth callbacks
  publicGatewayUrl?: string;
}

/**
 * Create settings routes
 */
export function createSettingsRoutes(config: SettingsRoutesConfig): Hono {
  const router = new Hono();

  // GET /settings - Render the settings page
  router.get("/settings", async (c) => {
    const token = c.req.query("token");

    if (!token) {
      return c.html(
        renderErrorPage("Missing token. Please use the link sent to you."),
        400
      );
    }

    const payload = verifySettingsToken(token);
    if (!payload) {
      return c.html(
        renderErrorPage(
          "Invalid or expired link. Use /configure to request a new settings link."
        ),
        401
      );
    }

    // Get current settings
    const settings = await config.agentSettingsStore.getSettings(
      payload.agentId
    );

    // Check if GitHub App is configured
    const githubAppConfigured = !!config.githubAuth;
    const githubAppInstallUrl = config.githubAppInstallUrl;

    return c.html(
      renderSettingsPage(payload, settings, token, {
        githubAppConfigured,
        githubAppInstallUrl,
      })
    );
  });

  // GET /api/v1/settings - Get current settings (JSON)
  router.get("/api/v1/settings", async (c) => {
    const token = c.req.query("token");

    if (!token) {
      return c.json({ error: "Missing token" }, 400);
    }

    const payload = verifySettingsToken(token);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    const settings = await config.agentSettingsStore.getSettings(
      payload.agentId
    );

    return c.json({
      agentId: payload.agentId,
      settings: settings || {},
    });
  });

  // POST /api/v1/settings - Save settings
  router.post("/api/v1/settings", async (c) => {
    const token = c.req.query("token");

    if (!token) {
      return c.json({ error: "Missing token" }, 400);
    }

    const payload = verifySettingsToken(token);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    try {
      const body = await c.req.json<Partial<AgentSettings>>();

      // Validate the settings
      const validatedSettings = validateSettings(body);

      await config.agentSettingsStore.saveSettings(
        payload.agentId,
        validatedSettings
      );

      logger.info(
        `Settings saved for agent ${payload.agentId} by user ${payload.userId}`
      );

      return c.json({
        success: true,
        agentId: payload.agentId,
      });
    } catch (error) {
      logger.error("Failed to save settings", { error });
      return c.json(
        {
          error:
            error instanceof Error ? error.message : "Failed to save settings",
        },
        400
      );
    }
  });

  // ============================================================================
  // Provider Routes
  // ============================================================================

  // GET /api/v1/settings/providers - Get connection status of all providers
  router.get("/api/v1/settings/providers", async (c) => {
    const token = c.req.query("token");

    if (!token) {
      return c.json({ error: "Missing token" }, 400);
    }

    const payload = verifySettingsToken(token);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    const providers: Record<string, { connected: boolean }> = {};

    // Check each configured provider
    if (config.providerStores) {
      for (const [name, store] of Object.entries(config.providerStores)) {
        try {
          providers[name] = {
            connected: await store.hasCredentials(payload.agentId),
          };
        } catch (error) {
          logger.error(`Failed to check ${name} credentials`, { error });
          providers[name] = { connected: false };
        }
      }
    }

    return c.json({ providers });
  });

  // GET /api/v1/settings/providers/:provider/login - Initiate OAuth flow
  router.get("/api/v1/settings/providers/:provider/login", async (c) => {
    const token = c.req.query("token");

    if (!token) {
      return c.json({ error: "Missing token" }, 400);
    }

    const payload = verifySettingsToken(token);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    const provider = c.req.param("provider");

    // Get OAuth client for provider
    const oauthClient = config.oauthClients?.[provider];
    if (!oauthClient) {
      return c.json({ error: `Unknown provider: ${provider}` }, 404);
    }

    // Need state store for OAuth
    if (!config.oauthStateStore) {
      return c.json({ error: "OAuth not configured" }, 500);
    }

    try {
      // Generate PKCE code verifier
      const codeVerifier = oauthClient.generateCodeVerifier();

      // Create OAuth state
      const state = await config.oauthStateStore.create(
        payload.userId,
        payload.agentId,
        codeVerifier,
        { platform: payload.platform, channelId: payload.agentId }
      );

      // Build auth URL and redirect
      const authUrl = oauthClient.buildAuthUrl(state, codeVerifier);

      logger.info(`Initiating ${provider} OAuth for agent ${payload.agentId}`);
      return c.redirect(authUrl);
    } catch (error) {
      logger.error(`Failed to initiate ${provider} OAuth`, { error });
      return c.json({ error: "Failed to initiate OAuth flow" }, 500);
    }
  });

  // POST /api/v1/settings/providers/:provider/logout - Disconnect provider
  router.post("/api/v1/settings/providers/:provider/logout", async (c) => {
    const token = c.req.query("token");

    if (!token) {
      return c.json({ error: "Missing token" }, 400);
    }

    const payload = verifySettingsToken(token);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    const provider = c.req.param("provider");

    // Get credential store for provider
    const store = config.providerStores?.[provider];
    if (!store) {
      return c.json({ error: `Unknown provider: ${provider}` }, 404);
    }

    try {
      await store.deleteCredentials(payload.agentId);
      logger.info(
        `Disconnected ${provider} for agent ${payload.agentId} by user ${payload.userId}`
      );
      return c.json({ success: true });
    } catch (error) {
      logger.error(`Failed to disconnect ${provider}`, { error });
      return c.json({ error: "Failed to disconnect provider" }, 500);
    }
  });

  // POST /api/v1/settings/providers/:provider/code - Exchange auth code for token
  router.post("/api/v1/settings/providers/:provider/code", async (c) => {
    const token = c.req.query("token");

    if (!token) {
      return c.json({ error: "Missing token" }, 400);
    }

    const payload = verifySettingsToken(token);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    const provider = c.req.param("provider");

    // Get OAuth client and credential store for provider
    const oauthClient = config.oauthClients?.[provider];
    const credentialStore = config.providerStores?.[provider];

    if (!oauthClient || !credentialStore) {
      return c.json({ error: `Unknown provider: ${provider}` }, 404);
    }

    if (!config.oauthStateStore) {
      return c.json({ error: "OAuth not configured" }, 500);
    }

    try {
      const body = await c.req.json<{ code: string }>();
      const input = body.code?.trim();

      if (!input) {
        return c.json({ error: "Missing authentication code" }, 400);
      }

      // Parse CODE#STATE format
      const parts = input.split("#");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return c.json({ error: "Invalid format - expected CODE#STATE" }, 400);
      }

      const authCode = parts[0].trim();
      const state = parts[1].trim();

      if (!authCode || !state) {
        return c.json({ error: "Missing code or state in input" }, 400);
      }

      // Retrieve and consume the OAuth state to get code verifier
      const stateData = await config.oauthStateStore.consume(state);
      if (!stateData) {
        return c.json(
          { error: "Invalid or expired authentication state" },
          400
        );
      }

      // Exchange code for tokens
      const credentials = await oauthClient.exchangeCodeForToken(
        authCode,
        stateData.codeVerifier,
        "https://console.anthropic.com/oauth/code/callback",
        state
      );

      // Store credentials
      await credentialStore.setCredentials(payload.agentId, credentials);

      logger.info(
        `OAuth code exchange successful for ${provider}, agent ${payload.agentId}`
      );
      return c.json({ success: true });
    } catch (error) {
      logger.error(`Failed to exchange ${provider} code`, { error });
      return c.json(
        {
          error:
            error instanceof Error ? error.message : "Failed to exchange code",
        },
        400
      );
    }
  });

  // ============================================================================
  // GitHub App Routes (for repo selection)
  // ============================================================================

  // GET /api/v1/settings/github/status - Get GitHub App status and installations
  router.get("/api/v1/settings/github/status", async (c) => {
    const token = c.req.query("token");

    if (!token) {
      return c.json({ error: "Missing token" }, 400);
    }

    const payload = verifySettingsToken(token);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    // If GitHub App is not configured, return that status
    if (!config.githubAuth) {
      logger.debug("GitHub App not configured - githubAuth is null/undefined");
      return c.json({
        configured: false,
        installUrl: null,
        installations: [],
      });
    }

    try {
      // Check if user has connected their GitHub account
      const settings = await config.agentSettingsStore.getSettings(
        payload.agentId
      );
      const githubUser = (settings as any)?.githubUser;

      // If user has a GitHub access token, use it to get ONLY their accessible installations
      if (githubUser?.accessToken) {
        logger.debug(
          `Fetching GitHub installations for user ${githubUser.login}...`
        );

        // Use user's token to get installations they have access to
        const userInstallationsResp = await fetch(
          "https://api.github.com/user/installations",
          {
            headers: {
              Authorization: `Bearer ${githubUser.accessToken}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "Peerbot",
            },
          }
        );

        if (userInstallationsResp.ok) {
          const userInstallationsData =
            (await userInstallationsResp.json()) as {
              installations: Array<{
                id: number;
                account: { login: string; type: string; avatar_url: string };
              }>;
            };

          logger.debug(
            `Found ${userInstallationsData.installations.length} installations for user ${githubUser.login}`
          );

          return c.json({
            configured: true,
            installUrl: config.githubAppInstallUrl || null,
            installations: userInstallationsData.installations.map((inst) => ({
              id: inst.id,
              account: inst.account.login,
              accountType: inst.account.type,
              avatarUrl: inst.account.avatar_url,
            })),
          });
        } else {
          // Token might be expired or revoked - fall through to show all installations
          logger.warn(
            `Failed to fetch user installations: ${userInstallationsResp.status}`
          );
        }
      }

      // Fallback: If no user token or token failed, return all installations
      // This is less secure but allows the feature to work without GitHub OAuth
      logger.debug(
        "Fetching all GitHub App installations (no user filtering)..."
      );
      const installations = await config.githubAuth.listInstallations();
      logger.debug(`Found ${installations.length} GitHub App installations`);

      return c.json({
        configured: true,
        installUrl: config.githubAppInstallUrl || null,
        installations: installations.map((inst) => ({
          id: inst.id,
          account: inst.account.login,
          accountType: inst.account.type,
          avatarUrl: inst.account.avatar_url,
        })),
      });
    } catch (error) {
      logger.error("Failed to get GitHub status", { error });
      return c.json({ error: "Failed to get GitHub status" }, 500);
    }
  });

  // GET /api/v1/settings/github/repos - Get repos for an installation
  router.get("/api/v1/settings/github/repos", async (c) => {
    const token = c.req.query("token");

    if (!token) {
      return c.json({ error: "Missing token" }, 400);
    }

    const payload = verifySettingsToken(token);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    if (!config.githubAuth) {
      return c.json({ error: "GitHub App not configured" }, 400);
    }

    const installationId = c.req.query("installation_id");
    if (!installationId) {
      return c.json({ error: "Missing installation_id" }, 400);
    }

    try {
      const repos = await config.githubAuth.listInstallationRepos(
        parseInt(installationId, 10)
      );

      return c.json({
        repos: repos.map((repo) => ({
          id: repo.id,
          name: repo.name,
          fullName: repo.full_name,
          private: repo.private,
          defaultBranch: repo.default_branch,
          owner: repo.owner.login,
        })),
      });
    } catch (error) {
      logger.error("Failed to get GitHub repos", { error });
      return c.json({ error: "Failed to get GitHub repos" }, 500);
    }
  });

  // GET /api/v1/settings/github/branches - Get branches for a repo
  router.get("/api/v1/settings/github/branches", async (c) => {
    const token = c.req.query("token");

    if (!token) {
      return c.json({ error: "Missing token" }, 400);
    }

    const payload = verifySettingsToken(token);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    if (!config.githubAuth) {
      return c.json({ error: "GitHub App not configured" }, 400);
    }

    const owner = c.req.query("owner");
    const repo = c.req.query("repo");
    const installationId = c.req.query("installation_id");

    if (!owner || !repo) {
      return c.json({ error: "Missing owner or repo" }, 400);
    }

    try {
      const branches = await config.githubAuth.listBranches(
        owner,
        repo,
        installationId ? parseInt(installationId, 10) : undefined
      );

      return c.json({
        branches: branches.map((branch) => ({
          name: branch.name,
          protected: branch.protected,
        })),
      });
    } catch (error) {
      logger.error("Failed to get GitHub branches", { error });
      return c.json({ error: "Failed to get GitHub branches" }, 500);
    }
  });

  // ============================================================================
  // GitHub OAuth Routes (for user identification)
  // ============================================================================

  // GET /api/v1/settings/github/oauth/login - Initiate GitHub OAuth flow
  router.get("/api/v1/settings/github/oauth/login", async (c) => {
    const token = c.req.query("token");

    if (!token) {
      return c.json({ error: "Missing token" }, 400);
    }

    const payload = verifySettingsToken(token);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    if (!config.githubOAuthClientId) {
      return c.json({ error: "GitHub OAuth not configured" }, 500);
    }

    if (!config.publicGatewayUrl) {
      return c.json({ error: "Public gateway URL not configured" }, 500);
    }

    // Generate state for CSRF protection (includes settings token for callback)
    const state = Buffer.from(
      JSON.stringify({
        settingsToken: token,
        timestamp: Date.now(),
      })
    ).toString("base64url");

    const redirectUri = `${config.publicGatewayUrl}/api/v1/settings/github/oauth/callback`;
    const authUrl = new URL("https://github.com/login/oauth/authorize");
    authUrl.searchParams.set("client_id", config.githubOAuthClientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", "read:user");
    authUrl.searchParams.set("state", state);

    logger.info(`Initiating GitHub OAuth for agent ${payload.agentId}`);
    return c.redirect(authUrl.toString());
  });

  // GET /api/v1/settings/github/oauth/callback - Handle GitHub OAuth callback
  router.get("/api/v1/settings/github/oauth/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");

    if (error) {
      logger.error("GitHub OAuth error", { error });
      return c.html(renderErrorPage(`GitHub OAuth failed: ${error}`), 400);
    }

    if (!code || !state) {
      return c.html(renderErrorPage("Missing code or state from GitHub"), 400);
    }

    // Decode state to get settings token
    let stateData: { settingsToken: string; timestamp: number };
    try {
      stateData = JSON.parse(Buffer.from(state, "base64url").toString("utf-8"));
    } catch {
      return c.html(renderErrorPage("Invalid OAuth state"), 400);
    }

    // Check state is not too old (10 minutes)
    if (Date.now() - stateData.timestamp > 10 * 60 * 1000) {
      return c.html(
        renderErrorPage("OAuth state expired. Please try again."),
        400
      );
    }

    // Verify the settings token
    const payload = verifySettingsToken(stateData.settingsToken);
    if (!payload) {
      return c.html(renderErrorPage("Invalid or expired settings token"), 401);
    }

    if (
      !config.githubOAuthClientId ||
      !config.githubOAuthClientSecret ||
      !config.publicGatewayUrl
    ) {
      return c.html(renderErrorPage("GitHub OAuth not configured"), 500);
    }

    try {
      // Exchange code for access token
      const tokenResponse = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            client_id: config.githubOAuthClientId,
            client_secret: config.githubOAuthClientSecret,
            code,
            redirect_uri: `${config.publicGatewayUrl}/api/v1/settings/github/oauth/callback`,
          }),
        }
      );

      const tokenData = (await tokenResponse.json()) as {
        access_token?: string;
        error?: string;
      };
      if (!tokenData.access_token) {
        logger.error("GitHub token exchange failed", { tokenData });
        return c.html(
          renderErrorPage(
            `GitHub authentication failed: ${tokenData.error || "Unknown error"}`
          ),
          400
        );
      }

      // Get user info from GitHub
      const userResponse = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "Peerbot",
        },
      });

      if (!userResponse.ok) {
        logger.error("Failed to fetch GitHub user", {
          status: userResponse.status,
        });
        return c.html(renderErrorPage("Failed to fetch GitHub user info"), 500);
      }

      const userData = (await userResponse.json()) as {
        login: string;
        id: number;
        avatar_url: string;
      };

      // Store the GitHub user info in agent settings (including access token for API calls)
      const currentSettings = await config.agentSettingsStore.getSettings(
        payload.agentId
      );
      await config.agentSettingsStore.updateSettings(payload.agentId, {
        ...currentSettings,
        githubUser: {
          login: userData.login,
          id: userData.id,
          avatarUrl: userData.avatar_url,
          accessToken: tokenData.access_token, // Store for user-scoped API calls
          connectedAt: Date.now(),
        },
      });

      logger.info(
        `GitHub user ${userData.login} connected for agent ${payload.agentId}`
      );

      // Redirect back to settings page with success
      return c.redirect(
        `/settings?token=${encodeURIComponent(stateData.settingsToken)}&github_connected=true`
      );
    } catch (err) {
      logger.error("GitHub OAuth callback error", { error: err });
      return c.html(
        renderErrorPage("Failed to complete GitHub authentication"),
        500
      );
    }
  });

  // POST /api/v1/settings/github/oauth/logout - Disconnect GitHub account
  router.post("/api/v1/settings/github/oauth/logout", async (c) => {
    const token = c.req.query("token");

    if (!token) {
      return c.json({ error: "Missing token" }, 400);
    }

    const payload = verifySettingsToken(token);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    try {
      const currentSettings = await config.agentSettingsStore.getSettings(
        payload.agentId
      );
      if (currentSettings) {
        // Remove GitHub user info
        const { githubUser: _, ...settingsWithoutGithub } =
          currentSettings as any;
        await config.agentSettingsStore.saveSettings(
          payload.agentId,
          settingsWithoutGithub
        );
      }

      logger.info(`GitHub disconnected for agent ${payload.agentId}`);
      return c.json({ success: true });
    } catch (err) {
      logger.error("Failed to disconnect GitHub", { error: err });
      return c.json({ error: "Failed to disconnect GitHub" }, 500);
    }
  });

  // GET /api/v1/settings/github/user - Get connected GitHub user info
  router.get("/api/v1/settings/github/user", async (c) => {
    const token = c.req.query("token");

    if (!token) {
      return c.json({ error: "Missing token" }, 400);
    }

    const payload = verifySettingsToken(token);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    try {
      const settings = await config.agentSettingsStore.getSettings(
        payload.agentId
      );
      const githubUser = (settings as any)?.githubUser;

      return c.json({
        connected: !!githubUser,
        user: githubUser
          ? {
              login: githubUser.login,
              id: githubUser.id,
              avatarUrl: githubUser.avatarUrl,
            }
          : null,
        oauthConfigured: !!config.githubOAuthClientId,
      });
    } catch (err) {
      logger.error("Failed to get GitHub user", { error: err });
      return c.json({ error: "Failed to get GitHub user" }, 500);
    }
  });

  // ============================================================================
  // Skills Routes
  // ============================================================================

  // Shared skills fetcher instance with caching
  const skillsFetcher = new SkillsFetcherService();

  // GET /api/v1/settings/skills/curated - Get curated skills list
  router.get("/api/v1/settings/skills/curated", async (c) => {
    const token = c.req.query("token");

    if (!token) {
      return c.json({ error: "Missing token" }, 400);
    }

    const payload = verifySettingsToken(token);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    return c.json({
      skills: skillsFetcher.getCuratedSkills(),
    });
  });

  // GET /api/v1/settings/skills/search - Search skills from skills.sh registry
  router.get("/api/v1/settings/skills/search", async (c) => {
    const token = c.req.query("token");

    if (!token) {
      return c.json({ error: "Missing token" }, 400);
    }

    const payload = verifySettingsToken(token);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    const query = c.req.query("q") || "";
    const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 50);

    try {
      const skills = await skillsFetcher.searchSkills(query, limit);
      return c.json({ skills });
    } catch (error) {
      logger.error("Failed to search skills", { error });
      return c.json({ error: "Failed to search skills" }, 500);
    }
  });

  // POST /api/v1/settings/skills/add - Add a skill by repo
  router.post("/api/v1/settings/skills/add", async (c) => {
    const token = c.req.query("token");

    if (!token) {
      return c.json({ error: "Missing token" }, 400);
    }

    const payload = verifySettingsToken(token);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    try {
      const { repo } = await c.req.json<{ repo: string }>();

      if (!repo || !repo.includes("/")) {
        return c.json({ error: "Invalid repo format. Use owner/repo" }, 400);
      }

      // Fetch skill metadata from GitHub
      const metadata = await skillsFetcher.fetchSkill(repo);

      // Get current settings
      const settings = await config.agentSettingsStore.getSettings(
        payload.agentId
      );
      const skillsConfig = settings?.skillsConfig || { skills: [] };

      // Check if already exists
      if (skillsConfig.skills.some((s) => s.repo === repo)) {
        return c.json({ error: "Skill already added" }, 400);
      }

      // Add new skill
      const newSkill: SkillConfig = {
        repo,
        name: metadata.name,
        description: metadata.description,
        enabled: true,
        content: metadata.content,
        contentFetchedAt: Date.now(),
      };

      skillsConfig.skills.push(newSkill);

      // Save updated settings
      await config.agentSettingsStore.updateSettings(payload.agentId, {
        skillsConfig,
      });

      logger.info(`Skill ${repo} added for agent ${payload.agentId}`);

      return c.json({
        success: true,
        skill: newSkill,
      });
    } catch (error) {
      logger.error("Failed to add skill", { error });
      return c.json(
        {
          error: error instanceof Error ? error.message : "Failed to add skill",
        },
        400
      );
    }
  });

  // POST /api/v1/settings/skills/toggle - Enable/disable a skill
  router.post("/api/v1/settings/skills/toggle", async (c) => {
    const token = c.req.query("token");

    if (!token) {
      return c.json({ error: "Missing token" }, 400);
    }

    const payload = verifySettingsToken(token);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    try {
      const { repo, enabled } = await c.req.json<{
        repo: string;
        enabled: boolean;
      }>();

      const settings = await config.agentSettingsStore.getSettings(
        payload.agentId
      );
      const skillsConfig = settings?.skillsConfig || { skills: [] };

      const skill = skillsConfig.skills.find((s) => s.repo === repo);
      if (!skill) {
        return c.json({ error: "Skill not found" }, 404);
      }

      skill.enabled = enabled;

      await config.agentSettingsStore.updateSettings(payload.agentId, {
        skillsConfig,
      });

      logger.info(
        `Skill ${repo} ${enabled ? "enabled" : "disabled"} for agent ${payload.agentId}`
      );

      return c.json({ success: true });
    } catch (error) {
      logger.error("Failed to toggle skill", { error });
      return c.json({ error: "Failed to toggle skill" }, 500);
    }
  });

  // DELETE /api/v1/settings/skills/remove - Remove a skill
  router.delete("/api/v1/settings/skills/remove", async (c) => {
    const token = c.req.query("token");

    if (!token) {
      return c.json({ error: "Missing token" }, 400);
    }

    const payload = verifySettingsToken(token);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    try {
      const { repo } = await c.req.json<{ repo: string }>();

      const settings = await config.agentSettingsStore.getSettings(
        payload.agentId
      );
      const skillsConfig = settings?.skillsConfig || { skills: [] };

      skillsConfig.skills = skillsConfig.skills.filter((s) => s.repo !== repo);

      await config.agentSettingsStore.updateSettings(payload.agentId, {
        skillsConfig,
      });

      logger.info(`Skill ${repo} removed for agent ${payload.agentId}`);

      return c.json({ success: true });
    } catch (error) {
      logger.error("Failed to remove skill", { error });
      return c.json({ error: "Failed to remove skill" }, 500);
    }
  });

  // POST /api/v1/settings/skills/refresh - Re-fetch skill content from GitHub
  router.post("/api/v1/settings/skills/refresh", async (c) => {
    const token = c.req.query("token");

    if (!token) {
      return c.json({ error: "Missing token" }, 400);
    }

    const payload = verifySettingsToken(token);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    try {
      const { repo } = await c.req.json<{ repo: string }>();

      const settings = await config.agentSettingsStore.getSettings(
        payload.agentId
      );
      const skillsConfig = settings?.skillsConfig || { skills: [] };

      const skill = skillsConfig.skills.find((s) => s.repo === repo);
      if (!skill) {
        return c.json({ error: "Skill not found" }, 404);
      }

      // Clear cache and re-fetch content
      skillsFetcher.clearCache(repo);
      const metadata = await skillsFetcher.fetchSkill(repo);

      // Update skill with fresh content
      skill.content = metadata.content;
      skill.contentFetchedAt = Date.now();

      await config.agentSettingsStore.updateSettings(payload.agentId, {
        skillsConfig,
      });

      logger.info(`Skill ${repo} refreshed for agent ${payload.agentId}`);

      return c.json({ success: true, fetchedAt: Date.now() });
    } catch (error) {
      logger.error("Failed to refresh skill", { error });
      return c.json({ error: "Failed to refresh skill" }, 500);
    }
  });

  // ============================================================================
  // Scheduled Reminders Routes
  // ============================================================================

  // GET /api/v1/settings/schedules - List all pending schedules for the agent
  router.get("/api/v1/settings/schedules", async (c) => {
    const token = c.req.query("token");

    if (!token) {
      return c.json({ error: "Missing token" }, 400);
    }

    const payload = verifySettingsToken(token);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    if (!config.scheduledWakeupService) {
      return c.json({ schedules: [] });
    }

    try {
      const schedules = await config.scheduledWakeupService.listPendingForAgent(
        payload.agentId
      );

      return c.json({
        schedules: schedules.map((s) => ({
          scheduleId: s.id,
          threadId: s.threadId,
          task: s.task,
          scheduledAt: s.scheduledAt,
          scheduledFor: s.triggerAt,
          status: s.status,
        })),
      });
    } catch (error) {
      logger.error("Failed to list schedules", { error });
      return c.json({ error: "Failed to list schedules" }, 500);
    }
  });

  // DELETE /api/v1/settings/schedules/:scheduleId - Cancel a scheduled reminder
  router.delete("/api/v1/settings/schedules/:scheduleId", async (c) => {
    const token = c.req.query("token");

    if (!token) {
      return c.json({ error: "Missing token" }, 400);
    }

    const payload = verifySettingsToken(token);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    if (!config.scheduledWakeupService) {
      return c.json({ error: "Scheduled wakeup service not configured" }, 500);
    }

    const scheduleId = c.req.param("scheduleId");
    if (!scheduleId) {
      return c.json({ error: "scheduleId is required" }, 400);
    }

    try {
      const success = await config.scheduledWakeupService.cancelByAgent(
        scheduleId,
        payload.agentId
      );

      if (!success) {
        return c.json({
          success: false,
          message: "Schedule not found or already triggered",
        });
      }

      logger.info(
        `Schedule ${scheduleId} cancelled by user ${payload.userId} for agent ${payload.agentId}`
      );

      return c.json({ success: true });
    } catch (error) {
      logger.error("Failed to cancel schedule", { error });
      const message =
        error instanceof Error ? error.message : "Failed to cancel schedule";
      return c.json({ error: message }, 400);
    }
  });

  logger.info("Settings routes registered");
  return router;
}

/**
 * Validate and sanitize settings input
 */
function validateSettings(
  input: Partial<AgentSettings>
): Omit<AgentSettings, "updatedAt"> {
  const settings: Omit<AgentSettings, "updatedAt"> = {};

  // Validate model
  if (input.model) {
    const validModels = [
      "claude-sonnet-4",
      "claude-sonnet-4-5",
      "claude-opus-4",
      "claude-haiku-4",
      "claude-haiku-4-5",
    ];
    if (!validModels.includes(input.model)) {
      throw new Error(`Invalid model: ${input.model}`);
    }
    settings.model = input.model;
  }

  // Validate networkConfig
  if (input.networkConfig) {
    settings.networkConfig = {};

    if (input.networkConfig.allowedDomains) {
      if (!Array.isArray(input.networkConfig.allowedDomains)) {
        throw new Error("allowedDomains must be an array");
      }
      settings.networkConfig.allowedDomains = input.networkConfig.allowedDomains
        .filter((d) => typeof d === "string" && d.trim())
        .map((d) => d.trim().toLowerCase());
    }

    if (input.networkConfig.deniedDomains) {
      if (!Array.isArray(input.networkConfig.deniedDomains)) {
        throw new Error("deniedDomains must be an array");
      }
      settings.networkConfig.deniedDomains = input.networkConfig.deniedDomains
        .filter((d) => typeof d === "string" && d.trim())
        .map((d) => d.trim().toLowerCase());
    }
  }

  // Validate gitConfig
  if (input.gitConfig?.repoUrl) {
    const repoUrl = input.gitConfig.repoUrl.trim();
    if (!repoUrl.startsWith("https://") && !repoUrl.startsWith("git@")) {
      throw new Error("Repository URL must start with https:// or git@");
    }

    settings.gitConfig = {
      repoUrl,
      branch: input.gitConfig.branch?.trim(),
      sparse: input.gitConfig.sparse
        ? input.gitConfig.sparse
            .filter((p): p is string => typeof p === "string" && !!p.trim())
            .map((p) => p.trim())
        : undefined,
    };
  }

  // Validate mcpServers (simplified validation)
  if (input.mcpServers) {
    if (typeof input.mcpServers !== "object") {
      throw new Error("mcpServers must be an object");
    }
    settings.mcpServers = input.mcpServers;
  }

  // Validate envVars
  if (input.envVars) {
    if (typeof input.envVars !== "object") {
      throw new Error("envVars must be an object");
    }
    settings.envVars = {};
    for (const [key, value] of Object.entries(input.envVars)) {
      if (typeof key === "string" && key.trim()) {
        // Basic key validation: alphanumeric, underscore, no spaces
        const cleanKey = key.trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(cleanKey)) {
          settings.envVars[cleanKey] = String(value);
        }
      }
    }
  }

  // Validate historyConfig
  if (input.historyConfig) {
    const validTimeframes = ["1d", "7d", "30d", "365d", "all"];
    if (
      input.historyConfig.timeframe &&
      !validTimeframes.includes(input.historyConfig.timeframe)
    ) {
      throw new Error(
        `Invalid history timeframe: ${input.historyConfig.timeframe}`
      );
    }

    settings.historyConfig = {
      enabled: Boolean(input.historyConfig.enabled),
      timeframe: input.historyConfig.timeframe || "7d",
      maxMessages: Math.min(
        Math.max(input.historyConfig.maxMessages || 100, 10),
        500
      ),
      includeBotMessages: input.historyConfig.includeBotMessages ?? true,
    };
  }

  return settings;
}
