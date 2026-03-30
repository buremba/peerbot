/**
 * Agent Page Routes
 *
 * Serves the unified settings/agent-selector page.
 * OAuth + claims is the only auth path. No fallback to encrypted tokens.
 *
 * Platforms that support webapp-initdata auth (e.g. Telegram) use their
 * platform-specific signed payloads for session creation.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { type AuthProfile, createLogger } from "@lobu/core";
import type {
  AgentMetadata,
  AgentMetadataStore,
} from "../../auth/agent-metadata-store";
import type { OAuthStateStore } from "../../auth/oauth/state-store";
import { collectProviderModelOptions } from "../../auth/provider-model-options";
import type { AgentSettingsStore } from "../../auth/settings";
import type { ClaimService } from "../../auth/settings/claim-service";
import type { SettingsOAuthClient } from "../../auth/settings/oauth-client";
import { resolveSettingsView } from "../../auth/settings/resolved-settings-view";
import type {
  PrefillMcpServer,
  SettingsTokenPayload,
} from "../../auth/settings/token-service";
import { verifyTelegramWebAppData } from "../../auth/telegram-webapp-auth";
import type { UserAgentsStore } from "../../auth/user-agents-store";
import type { ChannelBindingService } from "../../channels";
import { getAuthMethod } from "../../connections/platform-auth-methods";
import { getModelProviderModules } from "../../modules/module-system";
import {
  buildMessagePayload,
  resolveAgentOptions,
} from "../../services/platform-helpers";
import { platformAgentId } from "../../spaces";
import { resolvePublicBaseUrl } from "../../utils/public-url";
import type { ProviderMeta } from "./agent-page";
import {
  renderErrorPage,
  renderPickerPage,
  renderSettingsPage,
} from "./agent-page";
import {
  clearSettingsSessionCookie,
  setSettingsSessionCookie,
  verifySettingsSession,
} from "./settings-auth";

const logger = createLogger("settings-routes");

/**
 * Validate returnUrl to prevent open redirects.
 * Only allows relative paths under /agent or /api/v1/.
 */
function isSafeReturnUrl(url: string): boolean {
  if (!url.startsWith("/")) return false;
  // Block protocol-relative URLs (//evil.com)
  if (url.startsWith("//")) return false;
  return (
    url.startsWith("/agent") || url.startsWith("/api/v1/") || url === "/agents"
  );
}

function parsePrefillMcpServersParam(
  encoded?: string
): PrefillMcpServer[] | undefined {
  if (!encoded) return undefined;

  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf-8");
    const parsed = JSON.parse(decoded);
    if (!Array.isArray(parsed)) return undefined;

    const servers: PrefillMcpServer[] = parsed
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;

        const id = typeof entry.id === "string" ? entry.id.trim() : "";
        if (!id) return null;

        const server: PrefillMcpServer = { id };

        if (typeof entry.name === "string" && entry.name.trim()) {
          server.name = entry.name.trim();
        }
        if (typeof entry.url === "string" && entry.url.trim()) {
          server.url = entry.url.trim();
        }
        if (entry.type === "sse" || entry.type === "stdio") {
          server.type = entry.type;
        }
        if (typeof entry.command === "string" && entry.command.trim()) {
          server.command = entry.command.trim();
        }
        if (Array.isArray(entry.args)) {
          server.args = entry.args.filter(
            (arg: unknown): arg is string =>
              typeof arg === "string" && arg.trim().length > 0
          );
        }
        if (Array.isArray(entry.envVars)) {
          server.envVars = entry.envVars.filter(
            (envVar: unknown): envVar is string =>
              typeof envVar === "string" && envVar.trim().length > 0
          );
        }

        return server;
      })
      .filter((server): server is PrefillMcpServer => server !== null);

    return servers.length > 0 ? servers : undefined;
  } catch (error) {
    logger.warn("Invalid prefill MCP payload in query param", { error });
    return undefined;
  }
}

/** State data for settings OAuth flow */
interface SettingsOAuthStateData {
  userId: string;
  codeVerifier: string;
  returnUrl: string;
  redirectUri?: string;
}

export interface SettingsPageConfig {
  agentSettingsStore: AgentSettingsStore;
  userAgentsStore: UserAgentsStore;
  agentMetadataStore: AgentMetadataStore;
  channelBindingService: ChannelBindingService;
  connectionManager?: import("../../gateway/connection-manager").WorkerConnectionManager;
  /** Chat instance manager for looking up connections (scopes, template agents) */
  chatInstanceManager?: import("../../connections/chat-instance-manager").ChatInstanceManager;
  /** Settings OAuth client (optional — webapp-initdata auth works without it) */
  settingsOAuthClient?: SettingsOAuthClient;
  /** Settings OAuth state store (optional — required only when OAuth client is set) */
  settingsOAuthStateStore?: OAuthStateStore<SettingsOAuthStateData>;
  /** Claim service for channel ownership verification (required) */
  claimService: ClaimService;
  /** Platform registry for dispatching notifications */
  platformRegistry?: { get(platform: string): any };
  /** Interaction service for posting messages back to conversations */
  interactionService?: import("../../interactions").InteractionService;
  /** Queue producer for dispatching messages to workers */
  queueProducer?: import("../../infrastructure/queue/queue-producer").QueueProducer;
}

type ProviderCapability =
  | "text"
  | "image-generation"
  | "speech-to-text"
  | "text-to-speech";

const PROVIDER_CAPABILITY_ORDER: ProviderCapability[] = [
  "text",
  "image-generation",
  "speech-to-text",
  "text-to-speech",
];

function orderedCapabilities(
  capabilities: Set<ProviderCapability>
): ProviderCapability[] {
  return PROVIDER_CAPABILITY_ORDER.filter((capability) =>
    capabilities.has(capability)
  );
}

function parseJwtScopes(token: string): Set<string> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1] || "", "base64url").toString("utf-8")
    ) as {
      scope?: unknown;
      scp?: unknown;
    };
    const scopes: string[] = [];

    if (typeof payload.scope === "string") {
      scopes.push(...payload.scope.split(/\s+/));
    }
    if (typeof payload.scp === "string") {
      scopes.push(...payload.scp.split(/\s+/));
    }
    if (Array.isArray(payload.scp)) {
      scopes.push(
        ...payload.scp.filter(
          (value): value is string => typeof value === "string"
        )
      );
    }

    const cleaned = scopes.map((scope) => scope.trim()).filter(Boolean);
    return cleaned.length > 0 ? new Set(cleaned) : null;
  } catch {
    return null;
  }
}

function chatGptHasAudioScope(profile: AuthProfile): boolean {
  if (profile.authType === "api-key") return true;
  const scopes = parseJwtScopes(profile.credential);
  if (!scopes) return true;
  return (
    scopes.has("api.model.audio.request") || scopes.has("model.audio.request")
  );
}

function chatGptHasImageGenerationScope(profile: AuthProfile): boolean {
  if (profile.authType === "api-key") return true;
  const scopes = parseJwtScopes(profile.credential);
  if (!scopes) return true;
  return (
    scopes.has("api.model.image.request") ||
    scopes.has("api.model.request") ||
    scopes.has("model.image.request")
  );
}

function getPrimaryValidProfile(
  profiles: AuthProfile[] | undefined,
  providerId: string
): AuthProfile | undefined {
  if (!Array.isArray(profiles) || profiles.length === 0) return undefined;
  const now = Date.now();
  return profiles.find((profile) => {
    if (profile.provider !== providerId) return false;
    const expiresAt = profile.metadata?.expiresAt;
    return !expiresAt || expiresAt > now;
  });
}

function applyCapabilityOverrides(
  provider: ProviderMeta,
  authProfiles: AuthProfile[] | undefined
): ProviderMeta {
  if (provider.id !== "chatgpt") return provider;

  const primaryProfile = getPrimaryValidProfile(authProfiles, provider.id);
  if (!primaryProfile) {
    return provider;
  }

  const hasAudio = chatGptHasAudioScope(primaryProfile);
  const hasImageGeneration = chatGptHasImageGenerationScope(primaryProfile);
  if (hasAudio && hasImageGeneration) {
    return provider;
  }

  return {
    ...provider,
    capabilities: (provider.capabilities || []).filter(
      (capability) =>
        capability === "text" ||
        (capability === "image-generation" && hasImageGeneration) ||
        ((capability === "speech-to-text" || capability === "text-to-speech") &&
          hasAudio)
    ),
  };
}

function buildProviderMeta(
  m: ReturnType<typeof getModelProviderModules>[number]
): ProviderMeta {
  const providerId = m.providerId.toLowerCase();
  const capabilities = new Set<ProviderCapability>();

  if (providerId !== "elevenlabs") {
    capabilities.add("text");
  }
  if (providerId === "chatgpt" || providerId === "openai") {
    capabilities.add("image-generation");
  }
  if (
    providerId === "chatgpt" ||
    providerId === "openai" ||
    providerId === "gemini" ||
    providerId === "elevenlabs" ||
    providerId === "groq"
  ) {
    capabilities.add("speech-to-text");
  }
  if (
    providerId === "chatgpt" ||
    providerId === "openai" ||
    providerId === "gemini" ||
    providerId === "elevenlabs"
  ) {
    capabilities.add("text-to-speech");
  }

  return {
    id: m.providerId,
    name: m.providerDisplayName,
    iconUrl: m.providerIconUrl || "",
    authType: (m.authType || "oauth") as ProviderMeta["authType"],
    supportedAuthTypes:
      (m.supportedAuthTypes as ProviderMeta["supportedAuthTypes"]) || [
        m.authType || "oauth",
      ],
    apiKeyInstructions: m.apiKeyInstructions || "",
    apiKeyPlaceholder: m.apiKeyPlaceholder || "",
    catalogDescription: m.catalogDescription || "",
    capabilities: orderedCapabilities(capabilities),
  };
}

/**
 * Render the settings page for a resolved payload + agentId.
 */
async function renderSettingsForPayload(
  c: any,
  config: SettingsPageConfig,
  payload: SettingsTokenPayload,
  agentId: string
) {
  const [settingsView, agentMetadata] = await Promise.all([
    resolveSettingsView({
      agentId,
      agentSettingsStore: config.agentSettingsStore,
      agentMetadataStore: config.agentMetadataStore,
      viewer: {
        settingsMode: payload.settingsMode,
        allowedScopes: payload.allowedScopes,
        isAdmin: payload.isAdmin,
      },
    }),
    config.agentMetadataStore.getMetadata(agentId),
  ]);
  const settings = settingsView.effectiveSettings;

  // Build provider metadata from registry
  const allModules = getModelProviderModules();
  const allProviderMeta = allModules
    .filter((m) => m.catalogVisible !== false)
    .map(buildProviderMeta);

  // Resolve installed providers in order
  const installedIds = (settings?.installedProviders || []).map(
    (ip) => ip.providerId
  );
  const installedSet = new Set(installedIds);
  const installedProviders = installedIds
    .map((id) => allProviderMeta.find((p) => p.id === id))
    .filter((p): p is ProviderMeta => p !== undefined)
    .map((provider) =>
      applyCapabilityOverrides(provider, settings?.authProfiles)
    );

  // Catalog providers = all that are not installed
  const catalogProviders = allProviderMeta.filter(
    (p) => !installedSet.has(p.id)
  );

  const providerModelOptions = await collectProviderModelOptions(
    agentId,
    payload.userId
  );

  // Non-OAuth platforms don't need agent switching
  const isDeterministicPlatform =
    getAuthMethod(payload.platform).type !== "oauth";
  const showSwitcher = !isDeterministicPlatform && !!payload.channelId;

  // Get agents list for switcher (only if switcher is enabled)
  const agents: (AgentMetadata & { channelCount: number })[] = [];
  if (showSwitcher) {
    const agentIds = await config.userAgentsStore.listAgents(
      payload.platform || "unknown",
      payload.userId
    );
    for (const id of agentIds) {
      const metadata = await config.agentMetadataStore.getMetadata(id);
      if (metadata) {
        const bindings = await config.channelBindingService.listBindings(id);
        agents.push({ ...metadata, channelCount: bindings.length });
      }
    }

    // Ensure the currently active agent appears in switcher even when it is
    // not part of the user's direct agent list (e.g. workspace-bound agent).
    if (
      agentMetadata &&
      !agents.some((agent) => agent.agentId === agentMetadata.agentId)
    ) {
      const bindings = await config.channelBindingService.listBindings(
        agentMetadata.agentId
      );
      agents.unshift({ ...agentMetadata, channelCount: bindings.length });
    }
  }

  // Determine config-managed providers from manifest credentials
  let configManagedProviders: string[] = [];
  try {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const manifestRaw = readFileSync(
      resolve(process.cwd(), ".lobu/agents.json"),
      "utf-8"
    );
    const manifest = JSON.parse(manifestRaw);
    const manifestAgentId = settingsView.templateAgentId || agentId;
    const entry = manifest.agents?.find(
      (a: any) => a.agentId === manifestAgentId
    );
    if (entry?.credentials?.length) {
      configManagedProviders = entry.credentials.map((c: any) => c.providerId);
    }
  } catch {
    // Not a CLI-managed project or manifest not found
  }

  // Ensure the payload has agentId for the template (may have been resolved from binding)
  const effectivePayload = { ...payload, agentId };

  return c.html(
    renderSettingsPage(effectivePayload, settings, {
      memoryEnabled: !!process.env.AUTH_MCP_URL,
      scope: settingsView.scope,
      providers: installedProviders,
      catalogProviders,
      providerModelOptions,
      showSwitcher,
      agents,
      agentName: agentMetadata?.name,
      agentDescription: agentMetadata?.description,
      hasChannelId: !!payload.channelId,
      isSandbox: !!agentMetadata?.parentConnectionId,
      ownerPlatform: agentMetadata?.owner?.platform || "",
      templateAgentId: settingsView.templateAgentId,
      templateAgentName: settingsView.templateAgentName,
      sectionViews: settingsView.sections,
      providerViews: settingsView.providerSources,
      configManagedProviders,
    })
  );
}

export function createAgentPageRoutes(config: SettingsPageConfig): OpenAPIHono {
  const app = new OpenAPIHono();

  const oauthClient = config.settingsOAuthClient ?? null;
  const stateStore = config.settingsOAuthStateStore ?? null;
  const claimService = config.claimService;

  // ====================================================================
  // POST /agent/session — webapp-initdata authentication
  // ====================================================================
  app.post("/agent/session", async (c) => {
    const body = await c.req
      .json<{
        initData?: string;
        chatId?: string;
        platform?: string;
        connectionId?: string;
      }>()
      .catch(
        (): {
          initData?: string;
          chatId?: string;
          platform?: string;
          connectionId?: string;
        } => ({})
      );

    if (!body.initData) {
      return c.json({ error: "Missing initData" }, 400);
    }

    const platform = (body.platform ?? "").trim();
    if (!platform) {
      return c.json({ error: "Missing platform" }, 400);
    }

    const authMethod = getAuthMethod(platform);
    if (authMethod.type !== "webapp-initdata") {
      return c.json({ error: "Platform does not support initData auth" }, 400);
    }

    // Look up bot token from connection config (Chat SDK) or fall back to env
    let botToken: string | undefined;
    if (body.connectionId && config.chatInstanceManager) {
      botToken = config.chatInstanceManager.getConnectionConfigSecret(
        body.connectionId,
        "botToken"
      );
    }
    botToken ??= process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return c.json({ error: "Platform not configured" }, 500);
    }

    const chatId = (body.chatId ?? "").trim();
    if (!chatId) {
      return c.json({ error: "Missing chatId" }, 400);
    }

    const webAppData = verifyTelegramWebAppData(body.initData, botToken);
    if (!webAppData) {
      clearSettingsSessionCookie(c);
      return c.json({ error: "Invalid or expired initData" }, 401);
    }

    const userId = String(webAppData.user.id);

    // DM validation: chatId must equal userId
    const chatIdNum = Number(chatId);
    if (chatIdNum > 0 && chatId !== userId) {
      return c.json({ error: "Chat ID mismatch" }, 403);
    }

    const linkedOAuthUserId = await claimService.getLinkedOAuthUserId(
      platform,
      userId
    );

    // Linked users get a 24h session with oauthUserId (same as OAuth sessions)
    // Unlinked users get a 1h session without oauthUserId
    const sessionTtlMs = linkedOAuthUserId
      ? 24 * 60 * 60 * 1000
      : 60 * 60 * 1000;
    const session: SettingsTokenPayload = {
      userId,
      platform,
      channelId: chatId,
      exp: Date.now() + sessionTtlMs,
      ...(linkedOAuthUserId && { oauthUserId: linkedOAuthUserId }),
    };

    setSettingsSessionCookie(c, session);
    return c.json({ success: true });
  });

  // ====================================================================
  // OAuth Login Flow (only registered when OAuth client is configured)
  // ====================================================================

  if (oauthClient && stateStore) {
    /**
     * GET /agent/oauth/login — Start OAuth flow
     * Redirects to the OAuth provider's authorization page.
     * Preserves returnUrl through the OAuth round-trip.
     */
    app.get("/agent/oauth/login", async (c) => {
      const rawReturnUrl = c.req.query("returnUrl") || "/agent";
      const returnUrl = isSafeReturnUrl(rawReturnUrl) ? rawReturnUrl : "/agent";
      const codeVerifier = oauthClient.generateCodeVerifier();
      const redirectUri = `${resolvePublicBaseUrl({
        requestUrl: c.req.url,
        forwardedProto: c.req.header("x-forwarded-proto"),
      })}/agent/oauth/callback`;

      const state = await stateStore.create({
        userId: "pending", // will be resolved after OAuth
        codeVerifier,
        returnUrl,
        redirectUri,
      });

      const authUrl = await oauthClient.buildAuthUrl(
        state,
        codeVerifier,
        redirectUri
      );
      return c.redirect(authUrl);
    });

    /**
     * GET /agent/oauth/callback — OAuth callback
     * Exchanges code for token, fetches user info, creates session.
     */
    app.get("/agent/oauth/callback", async (c) => {
      const code = c.req.query("code");
      const stateParam = c.req.query("state");
      const error = c.req.query("error");

      if (error) {
        logger.warn("OAuth callback error", { error });
        return c.html(renderErrorPage(`OAuth login failed: ${error}`), 400);
      }

      if (!code || !stateParam) {
        return c.html(
          renderErrorPage("Missing code or state in OAuth callback"),
          400
        );
      }

      // Consume state
      const stateData = await stateStore.consume(stateParam);
      if (!stateData) {
        return c.html(
          renderErrorPage("Invalid or expired OAuth state. Please try again."),
          400
        );
      }

      try {
        // Exchange code for token (use the same redirectUri from the authorize step)
        const credentials = await oauthClient.exchangeCodeForToken(
          code,
          stateData.codeVerifier,
          stateData.redirectUri
        );

        // Fetch user info
        const userInfo = await oauthClient.fetchUserInfo(
          credentials.accessToken
        );

        // Validate OAuth user ID (used as Redis key)
        if (
          !userInfo.sub ||
          typeof userInfo.sub !== "string" ||
          userInfo.sub.length > 255 ||
          /[:\s]/.test(userInfo.sub)
        ) {
          logger.error("Invalid OAuth user ID", { sub: userInfo.sub });
          return c.html(
            renderErrorPage("Invalid user identity from OAuth provider."),
            500
          );
        }

        // Create unified session (24h TTL)
        const sessionTtlMs = 24 * 60 * 60 * 1000;
        const session: SettingsTokenPayload = {
          userId: userInfo.sub,
          platform: "unknown",
          oauthUserId: userInfo.sub,
          email: userInfo.email,
          name: userInfo.name,
          exp: Date.now() + sessionTtlMs,
          isAdmin: true,
        };

        setSettingsSessionCookie(c, session);
        logger.info("OAuth login successful", {
          oauthUserId: userInfo.sub,
          email: userInfo.email,
        });

        // Redirect to the original settings URL (with claim/agent params preserved)
        const safeReturnUrl = isSafeReturnUrl(stateData.returnUrl)
          ? stateData.returnUrl
          : "/agent";
        return c.redirect(safeReturnUrl);
      } catch (err) {
        logger.error("OAuth callback failed", { error: err });
        return c.html(
          renderErrorPage("OAuth login failed. Please try again."),
          500
        );
      }
    });
  } else {
    // OAuth not configured — return helpful error for OAuth-only paths
    app.get("/agent/oauth/login", (c) =>
      c.html(
        renderErrorPage(
          "OAuth login is not configured. Use /configure in your chat to access settings."
        ),
        501
      )
    );
    app.get("/agent/oauth/callback", (c) =>
      c.html(renderErrorPage("OAuth login is not configured."), 501)
    );
  }

  // ====================================================================
  // GET /agent/:agentId? — Main agent page (agentId optional for picker)
  // ====================================================================
  const agentPageHandler = async (c: any) => {
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store, max-age=0");
    c.header("Pragma", "no-cache");

    // 1. Verify session from cookie
    let session = verifySettingsSession(c);

    // 1b. Claim-based flow: if the URL has ?claim= and the existing session
    // lacks an oauthUserId (e.g. webapp-initdata session), clear the stale
    // session so the claim+OAuth flow can proceed properly.
    if (session && c.req.query("claim") && !session.oauthUserId) {
      clearSettingsSessionCookie(c);
      session = null;
    }

    // 2. No session + webapp-initdata platform URL → render bootstrap page
    // Must happen before claim handling, otherwise WebApp links that
    // include claim=... will be redirected to OAuth login unnecessarily.
    if (!session) {
      const qp = c.req.query("platform");
      const chatId = c.req.query("chat");
      if (qp && chatId && getAuthMethod(qp).type === "webapp-initdata") {
        return c.html(renderWebAppBootstrapPage());
      }

      // 3. No session + ?claim= → redirect to OAuth login (preserving returnUrl)
      if (c.req.query("claim")) {
        if (!oauthClient) {
          return c.html(
            renderErrorPage(
              "OAuth login is not configured. Use /configure in your chat to access settings."
            ),
            501
          );
        }
        const currentUrl = new URL(c.req.url);
        const returnUrl = `${currentUrl.pathname}${currentUrl.search}`;
        return c.redirect(
          `/agent/oauth/login?returnUrl=${encodeURIComponent(returnUrl)}`
        );
      }

      // No session — redirect to OAuth login if available, otherwise show error
      if (oauthClient) {
        return c.redirect("/agent/oauth/login");
      }
      return c.html(
        renderErrorPage(
          "No active session. Use /configure in your chat to get a settings link."
        ),
        401
      );
    }

    // 4. Session + ?claim= → process claim, grant access, redirect
    const claimCode = c.req.query("claim");
    if (claimCode) {
      const oauthUserId = session.oauthUserId;
      if (oauthUserId) {
        const claimData = await claimService.consumeClaim(claimCode);
        if (claimData) {
          await claimService.grantAccess(
            oauthUserId,
            claimData.platform,
            claimData.channelId
          );

          // Link platform identity → OAuth user for future initData sessions
          const wasAlreadyLinked = await claimService.getLinkedOAuthUserId(
            claimData.platform,
            claimData.platformUserId
          );
          await claimService.linkPlatformIdentity(
            claimData.platform,
            claimData.platformUserId,
            oauthUserId
          );

          logger.info("Claim processed, access granted", {
            oauthUserId,
            platform: claimData.platform,
            channelId: claimData.channelId,
            wasAlreadyLinked: !!wasAlreadyLinked,
          });

          if (!wasAlreadyLinked) {
            config.platformRegistry
              ?.get(claimData.platform)
              ?.notifyIdentityLinked?.(claimData.channelId);
          }

          // Redirect to clean URL (strip claim param, keep agent/channel params)
          const cleanUrl = new URL(c.req.url);
          cleanUrl.searchParams.delete("claim");

          const binding = await config.channelBindingService.getBinding(
            claimData.platform,
            claimData.channelId
          );

          // Reconcile user-agents index for the claimed platform identity.
          if (binding) {
            config.userAgentsStore
              .addAgent(
                claimData.platform,
                claimData.platformUserId,
                binding.agentId
              )
              .catch(() => {
                /* best-effort reconciliation */
              });
          }

          // Bind OAuth session to the claimed platform identity for subsequent
          // authorization checks on config/auth APIs.
          const resolvedAgentId = c.req.query("agent") || binding?.agentId;
          const claimedSession: SettingsTokenPayload = {
            ...session,
            platform: claimData.platform,
            channelId: claimData.channelId,
            userId: claimData.platformUserId,
            ...(resolvedAgentId && { agentId: resolvedAgentId }),
          };
          setSettingsSessionCookie(c, claimedSession);

          // Resolve agentId for the redirect path
          const claimAgentId =
            cleanUrl.searchParams.get("agent") || binding?.agentId;
          cleanUrl.searchParams.delete("agent");
          if (!cleanUrl.searchParams.has("platform")) {
            cleanUrl.searchParams.set("platform", claimData.platform);
          }
          if (!cleanUrl.searchParams.has("channel")) {
            cleanUrl.searchParams.set("channel", claimData.channelId);
          }

          const redirectPath = claimAgentId
            ? `/agent/${encodeURIComponent(claimAgentId)}`
            : "/agent";
          return c.redirect(`${redirectPath}${cleanUrl.search}`, 303);
        } else {
          logger.warn("Invalid or expired claim code", { claimCode });
        }
      }
    }

    // 5. Session + agent → render settings (path param or query fallback)
    const agentParam = c.req.param?.("agentId") || c.req.query("agent");
    const channelParam = c.req.query("channel");
    const platformParam = c.req.query("platform");

    let agentId: string | undefined = agentParam;

    // If channel+platform provided, resolve agent via binding
    if (!agentId && channelParam && platformParam) {
      // Check access for OAuth sessions
      if (session.oauthUserId) {
        const hasAccess = await claimService.hasAccess(
          session.oauthUserId,
          platformParam,
          channelParam
        );
        if (!hasAccess) {
          return c.html(
            renderErrorPage(
              "You don't have access to this channel's settings. Use /configure in the chat to get access."
            ),
            403
          );
        }
      }

      const binding = await config.channelBindingService.getBinding(
        platformParam,
        channelParam
      );
      if (binding) {
        agentId = binding.agentId;
      }
    }

    // For sessions with channelId, resolve agent via binding or deterministic ID
    if (!agentId && session.channelId && session.platform) {
      const binding = await config.channelBindingService.getBinding(
        session.platform,
        session.channelId
      );
      if (binding) {
        agentId = binding.agentId;
      } else if (getAuthMethod(session.platform).type !== "oauth") {
        // Deterministic agent ID for non-OAuth platforms — no binding needed
        const isGroup = session.channelId.startsWith("-");
        agentId = platformAgentId(
          session.platform,
          session.userId,
          session.channelId,
          isGroup
        );
      }
    }

    // Verify OAuth sessions have access to the resolved agent
    if (agentId && session.oauthUserId) {
      // Non-OAuth platform agents are owned by the session user — no binding check needed
      const isDeterministicAgent =
        getAuthMethod(session.platform).type !== "oauth";

      if (!isDeterministicAgent && session.agentId !== agentId) {
        const channels = await claimService.getAccessibleChannels(
          session.oauthUserId
        );
        if (channels.length === 0) {
          return c.html(
            renderErrorPage(
              "No channels configured. Use /configure in a chat first."
            ),
            403
          );
        }

        // Check the agent is reachable from an accessible channel
        const accessibleAgentIds = new Set<string>();
        for (const ch of channels) {
          const binding = await config.channelBindingService.getBinding(
            ch.platform,
            ch.channelId
          );
          if (binding) accessibleAgentIds.add(binding.agentId);
        }
        if (!accessibleAgentIds.has(agentId)) {
          return c.html(
            renderErrorPage(
              "You don't have access to this agent. Use /configure in the chat to get access."
            ),
            403
          );
        }
      }
    }

    // 6. No agentId resolved: show dashboard of accessible channels
    if (!agentId && session.oauthUserId) {
      // OAuth session: show accessible channels
      const channels = await claimService.getAccessibleChannels(
        session.oauthUserId
      );

      if (channels.length === 0) {
        return c.html(
          renderErrorPage(
            "No channels configured yet. Use /configure in a chat to link your account."
          ),
          200
        );
      }

      // Try to find agents for all accessible channels
      const agents: (AgentMetadata & { channelCount: number })[] = [];
      const seenAgents = new Set<string>();
      for (const ch of channels) {
        // 1. Try channel binding first
        const binding = await config.channelBindingService.getBinding(
          ch.platform,
          ch.channelId
        );
        if (binding && !seenAgents.has(binding.agentId)) {
          seenAgents.add(binding.agentId);
          const metadata = await config.agentMetadataStore.getMetadata(
            binding.agentId
          );
          if (metadata) {
            const bindings = await config.channelBindingService.listBindings(
              binding.agentId
            );
            agents.push({ ...metadata, channelCount: bindings.length });
          }
        }

        // 2. Fallback for DM channels without bindings: resolve via user_agents.
        // For DMs, channelId == userId on most platforms (Telegram, WhatsApp).
        // Groups should always have channel bindings so this path won't fire for them.
        if (!binding && !ch.channelId.startsWith("-")) {
          const userAgentIds = await config.userAgentsStore.listAgents(
            ch.platform,
            ch.channelId
          );
          for (const aid of userAgentIds) {
            if (seenAgents.has(aid)) continue;
            seenAgents.add(aid);
            const metadata = await config.agentMetadataStore.getMetadata(aid);
            if (metadata) {
              const bindings =
                await config.channelBindingService.listBindings(aid);
              agents.push({ ...metadata, channelCount: bindings.length });
            }
          }
        }
      }

      if (agents.length === 1 && agents[0]) {
        agentId = agents[0].agentId;
      } else {
        // Multiple or zero agents: show picker
        const displayUserId =
          session.email ||
          session.name ||
          (session.userId !== session.oauthUserId ? session.userId : null) ||
          session.oauthUserId ||
          session.userId;
        const syntheticPayload: SettingsTokenPayload = {
          userId: displayUserId,
          platform: channels[0]?.platform || session.platform || "unknown",
          channelId: session.channelId || channels[0]?.channelId,
          exp: session.exp,
        };
        return c.html(renderPickerPage(syntheticPayload, agents));
      }
    }

    if (!agentId) {
      // Non-OAuth session with channelId: show agent picker
      if (session.channelId && session.platform) {
        const agentIds = await config.userAgentsStore.listAgents(
          session.platform,
          session.userId
        );

        const agents: (AgentMetadata & { channelCount: number })[] = [];
        for (const id of agentIds) {
          const metadata = await config.agentMetadataStore.getMetadata(id);
          if (metadata) {
            const bindings =
              await config.channelBindingService.listBindings(id);
            agents.push({ ...metadata, channelCount: bindings.length });
          }
        }

        return c.html(
          renderPickerPage(session as SettingsTokenPayload, agents)
        );
      }

      return c.html(
        renderErrorPage(
          "No agent specified. Use /configure in a chat to get a settings link."
        ),
        400
      );
    }

    // Update session cookie to include agentId for provider OAuth flows
    if (agentId && session.agentId !== agentId) {
      setSettingsSessionCookie(c, { ...session, agentId });
    }

    // Build payload for rendering
    // For non-OAuth platforms, use the platform userId directly, not the opaque OAuth ID
    const effectivePlatform = platformParam || session.platform || "unknown";
    const isDeterministic = getAuthMethod(effectivePlatform).type !== "oauth";
    const payload: SettingsTokenPayload = {
      userId: isDeterministic
        ? session.userId
        : session.oauthUserId || session.userId,
      platform: effectivePlatform,
      channelId: channelParam || session.channelId,
      agentId,
      exp: session.exp,
      isAdmin: session.isAdmin,
      // Parse prefill query params (set by settings-link.ts for claim-based flows)
      message: c.req.query("message") || undefined,
      prefillSkills: c.req.query("skills")
        ? c.req
            .query("skills")!
            .split(",")
            .filter(Boolean)
            .map((repo: string) => ({ repo }))
        : undefined,
      prefillGrants: c.req.query("grants")
        ? c.req.query("grants")!.split(",").filter(Boolean)
        : undefined,
      prefillNixPackages: c.req.query("nix")
        ? c.req.query("nix")!.split(",").filter(Boolean)
        : undefined,
      prefillMcpServers: parsePrefillMcpServersParam(c.req.query("mcps")),
      prefillProviders: c.req.query("providers")
        ? c.req.query("providers")!.split(",").filter(Boolean)
        : undefined,
      // Thread source conversation context for post-install callbacks
      sourceContext: c.req.query("conversationId")
        ? {
            conversationId: c.req.query("conversationId")!,
            channelId: channelParam || session.channelId || "",
            teamId: session.teamId,
            platform: effectivePlatform,
          }
        : undefined,
      connectionId: c.req.query("connectionId") || undefined,
    };

    // Resolve scoped settings mode from connectionId or sandbox's parent connection
    // For sandbox agents, always apply scopes (even for admins — admin manages from parent)
    const agentMeta = await config.agentMetadataStore.getMetadata(agentId);
    const isSandboxAgent = !!agentMeta?.parentConnectionId;
    if (!payload.isAdmin || isSandboxAgent) {
      const connectionIdParam = c.req.query("connectionId");
      const resolvedConnectionId =
        connectionIdParam || agentMeta?.parentConnectionId;
      if (resolvedConnectionId && config.chatInstanceManager) {
        const connection =
          await config.chatInstanceManager.getConnection(resolvedConnectionId);
        if (connection?.settings?.userConfigScopes) {
          payload.settingsMode = "user";
          payload.allowedScopes = connection.settings.userConfigScopes;
          payload.connectionId = resolvedConnectionId;
        }
      }
    }

    return await renderSettingsForPayload(c, config, payload, agentId);
  };
  // GET /agent/logout — must be before the :agentId catch-all
  app.get("/agent/logout", (c) => {
    clearSettingsSessionCookie(c);
    return c.redirect("/agents/login");
  });

  app.get("/agent", agentPageHandler);
  app.get("/agent/:agentId", agentPageHandler);

  // POST /api/v1/agents/:agentId/install-callback — Notify conversation after skill install
  app.post("/api/v1/agents/:agentId/install-callback", async (c) => {
    const agentId = c.req.param("agentId");

    const body = await c.req
      .json<{
        platform: string;
        channelId: string;
        conversationId: string;
        connectionId?: string;
        skills: string[];
      }>()
      .catch(() => null);

    if (!body?.conversationId || !body?.channelId || !body?.skills?.length) {
      return c.json({ error: "Missing required fields" }, 400);
    }

    if (!config.interactionService) {
      return c.json({ error: "Interaction service not configured" }, 500);
    }

    try {
      const skillList = body.skills.join(", ");
      if (config.queueProducer) {
        // All deps met — trigger the agent to continue
        const agentOptions = await resolveAgentOptions(
          agentId,
          {},
          config.agentSettingsStore
        );
        const messageId = `install-cb-${Date.now()}`;
        const payload = buildMessagePayload({
          platform: body.platform,
          userId: "system",
          botId: body.platform,
          conversationId: body.conversationId,
          teamId: body.platform,
          agentId,
          messageId,
          messageText: `[System: ${skillList} has been installed and is ready to use. Continue with the task.]`,
          channelId: body.channelId,
          platformMetadata: {
            agentId,
            source: "install-callback",
            connectionId: body.connectionId,
          },
          agentOptions,
        });
        await config.queueProducer.enqueueMessage(payload);
      }

      return c.json({ success: true });
    } catch (error) {
      logger.error("Install callback failed", { error, agentId });
      return c.json({ error: "Failed to send notification" }, 500);
    }
  });

  return app;
}

/**
 * Minimal bootstrap page for webapp-initdata authentication.
 * Extracts initData from the URL hash fragment and POSTs to /agent/session.
 */
function renderWebAppBootstrapPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <title>Loading Settings - Lobu</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.25rem; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: linear-gradient(to bottom right, #334155, #0f172a); color: #e2e8f0; }
    .card { background: #0f172a; border: 1px solid #334155; border-radius: 1rem; box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.35); padding: 1.5rem; max-width: 28rem; width: 100%; text-align: center; }
    .spinner { width: 1.25rem; height: 1.25rem; border: 2px solid #475569; border-top-color: #cbd5e1; border-radius: 9999px; margin: 0 auto 0.75rem; animation: spin 0.8s linear infinite; }
    .error { display: none; margin-top: 0.75rem; font-size: 0.875rem; color: #fca5a5; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div id="spinner" class="spinner"></div>
    <p id="status">Securing your settings session...</p>
    <p id="error" class="error"></p>
  </div>
  <script>
    (async function () {
      var errorEl = document.getElementById('error');
      var statusEl = document.getElementById('status');
      var spinnerEl = document.getElementById('spinner');

      function showError(message) {
        statusEl.textContent = 'Unable to open settings.';
        errorEl.textContent = message;
        errorEl.style.display = 'block';
        spinnerEl.style.display = 'none';
      }

      var qp = new URLSearchParams(window.location.search);
      var chatId = qp.get('chat');
      var platform = qp.get('platform') || '';
      var connectionId = qp.get('connectionId') || '';

      // WebApp injects initData as #tgWebAppData=<url-encoded-initData>&...
      var hashStr = window.location.hash ? window.location.hash.slice(1) : '';
      var hashParams = new URLSearchParams(hashStr);
      var initData = hashParams.get('tgWebAppData') || '';

      if (!initData) {
        showError('Could not authenticate. Please open this link using the button in your chat app, not as a regular URL.');
        return;
      }

      try {
        var resp = await fetch('/agent/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData: initData, chatId: chatId, platform: platform, connectionId: connectionId })
        });
        if (resp.ok) {
          var rp = new URLSearchParams(window.location.search);
          rp.delete('platform');
          rp.delete('chat');
          var redirectUrl = '/agent' + (rp.toString() ? '?' + rp.toString() : '');
          var cleanUrl = new URL(window.location.href);
          cleanUrl.hash = '';
          cleanUrl.search = '';
          window.history.replaceState({}, '', cleanUrl.pathname);
          window.location.replace(redirectUrl);
          return;
        }
        var result = await resp.json().catch(function () { return {}; });
        showError(result.error || 'Authentication failed.');
      } catch (e) {
        showError('Network error while authenticating.');
      }
    })();
  </script>
</body>
</html>`;
}
