import {
  BaseModule,
  createLogger,
  type ModelProviderModule,
  type ProviderUpstreamConfig,
} from "@lobu/core";
import { Hono } from "hono";
import {
  type AuthProfilesManager,
  createAuthProfileLabel,
} from "./settings/auth-profiles-manager";
import { verifySettingsToken } from "./settings/token-service";

const logger = createLogger("base-provider-module");

export interface BaseProviderConfig {
  providerId: string;
  providerDisplayName: string;
  providerIconUrl: string;
  /** Env var name the SDK expects for the API credential (e.g. "ANTHROPIC_API_KEY") */
  credentialEnvVarName: string;
  /** All env vars this provider considers secrets */
  secretEnvVarNames: string[];
  /** Env var to check for system key (defaults to credentialEnvVarName) */
  systemEnvVarName?: string;
  /** Provider slug for proxy path routing (e.g. "anthropic") */
  slug?: string;
  /** Upstream base URL for proxy forwarding (e.g. "https://api.anthropic.com") */
  upstreamBaseUrl?: string;
  /** Explicit base URL env var name (defaults to slug-derived name) */
  baseUrlEnvVarName?: string;
  authType: "oauth" | "device-code" | "api-key";
  supportedAuthTypes?: ("oauth" | "device-code" | "api-key")[];
  apiKeyInstructions?: string;
  apiKeyPlaceholder?: string;
  catalogDescription?: string;
  catalogVisible?: boolean;
}

/**
 * Base class for model provider modules.
 * Implements shared logic: credential lookup, proxy mappings, env var injection,
 * /save-key and /logout routes, and Hono app management.
 *
 * Subclasses provide a config object and optionally override:
 * - `setupRoutes(app)` to add provider-specific routes
 * - `getModelOptions()` for model listing
 * - `buildEnvVars()` for custom env var injection
 * - `hasSystemKey()` / `injectSystemKeyFallback()` for multi-env-var logic
 */
export abstract class BaseProviderModule
  extends BaseModule
  implements ModelProviderModule
{
  name: string;
  providerId: string;
  providerDisplayName: string;
  providerIconUrl: string;
  authType: "oauth" | "device-code" | "api-key";
  supportedAuthTypes?: ("oauth" | "device-code" | "api-key")[];
  apiKeyInstructions?: string;
  apiKeyPlaceholder?: string;
  catalogDescription?: string;
  catalogVisible?: boolean;

  protected readonly providerConfig: BaseProviderConfig;
  protected readonly authProfilesManager: AuthProfilesManager;
  protected readonly app: Hono;

  constructor(
    config: BaseProviderConfig,
    authProfilesManager: AuthProfilesManager
  ) {
    super();
    this.providerConfig = config;
    this.authProfilesManager = authProfilesManager;

    this.providerId = config.providerId;
    this.name = `${config.providerId}-provider`;
    this.providerDisplayName = config.providerDisplayName;
    this.providerIconUrl = config.providerIconUrl;
    this.authType = config.authType;
    this.supportedAuthTypes = config.supportedAuthTypes;
    this.apiKeyInstructions = config.apiKeyInstructions;
    this.apiKeyPlaceholder = config.apiKeyPlaceholder;
    this.catalogDescription = config.catalogDescription;
    this.catalogVisible = config.catalogVisible;

    this.app = new Hono();
    this.setupBaseRoutes();
    this.setupRoutes();
  }

  isEnabled(): boolean {
    return true;
  }

  getSecretEnvVarNames(): string[] {
    return this.providerConfig.secretEnvVarNames;
  }

  getCredentialEnvVarName(): string {
    return this.providerConfig.credentialEnvVarName;
  }

  getUpstreamConfig(): ProviderUpstreamConfig | null {
    const { slug, upstreamBaseUrl } = this.providerConfig;
    if (!slug || !upstreamBaseUrl) return null;
    return { slug, upstreamBaseUrl };
  }

  async hasCredentials(agentId: string): Promise<boolean> {
    return this.authProfilesManager.hasProviderProfiles(
      agentId,
      this.providerId
    );
  }

  hasSystemKey(): boolean {
    const envVar =
      this.providerConfig.systemEnvVarName ||
      this.providerConfig.credentialEnvVarName;
    return !!process.env[envVar];
  }

  getProxyBaseUrlMappings(
    proxyUrl: string,
    agentId?: string
  ): Record<string, string> {
    const { slug, baseUrlEnvVarName, credentialEnvVarName } =
      this.providerConfig;
    if (!slug) return {};
    const envVar =
      baseUrlEnvVarName || credentialEnvVarName.replace("_KEY", "_BASE_URL");
    const base = `${proxyUrl}/${slug}`;
    return { [envVar]: agentId ? `${base}/a/${agentId}` : base };
  }

  injectSystemKeyFallback(
    envVars: Record<string, string>
  ): Record<string, string> {
    const credVar = this.providerConfig.credentialEnvVarName;
    if (!envVars[credVar]) {
      const sysVar = this.providerConfig.systemEnvVarName || credVar;
      const systemKey = process.env[sysVar];
      if (systemKey) {
        envVars[credVar] = systemKey;
      }
    }
    return envVars;
  }

  async buildEnvVars(
    agentId: string,
    envVars: Record<string, string>
  ): Promise<Record<string, string>> {
    const credVar = this.providerConfig.credentialEnvVarName;
    if (!envVars[credVar]) {
      const profile = await this.authProfilesManager.getBestProfile(
        agentId,
        this.providerId
      );
      if (profile?.credential) {
        logger.info(
          `Injecting ${credVar} for agent ${agentId} (${this.providerId})`
        );
        envVars[credVar] = profile.credential;
      }
    }
    return envVars;
  }

  getApp(): Hono {
    return this.app;
  }

  protected async getCredential(agentId: string): Promise<string | null> {
    const profile = await this.authProfilesManager.getBestProfile(
      agentId,
      this.providerId
    );
    if (profile?.credential) {
      return profile.credential;
    }
    const sysVar =
      this.providerConfig.systemEnvVarName ||
      this.providerConfig.credentialEnvVarName;
    return process.env[sysVar] || null;
  }

  /** Override in subclasses to add provider-specific routes. */
  protected setupRoutes(): void {
    // Default: no extra routes
  }

  private isAuthorized(token: string | undefined, agentId: string): boolean {
    if (!token) return false;

    const payload = verifySettingsToken(token);
    if (!payload) return false;

    // Only allow agent-bound tokens for credential mutation endpoints.
    // Channel-scoped tokens do not identify a specific agent and must not be
    // accepted here to avoid cross-agent credential writes/deletes.
    if (!payload.agentId || payload.agentId !== agentId) {
      return false;
    }

    return true;
  }

  private setupBaseRoutes(): void {
    // Save API key
    this.app.post("/save-key", async (c) => {
      try {
        const body = await c.req.json();
        const { agentId, apiKey, token } = body;

        if (!agentId || !apiKey) {
          return c.json({ error: "Missing agentId or apiKey" }, 400);
        }

        const queryToken = c.req.query("token");
        const authToken = typeof token === "string" ? token : queryToken;
        if (!this.isAuthorized(authToken, agentId)) {
          return c.json({ error: "Unauthorized" }, 401);
        }

        await this.authProfilesManager.upsertProfile({
          agentId,
          provider: this.providerId,
          credential: apiKey,
          authType: "api-key",
          label: createAuthProfileLabel(this.providerDisplayName, apiKey),
          makePrimary: true,
        });

        logger.info(
          `${this.providerDisplayName} API key saved for agent ${agentId}`
        );
        return c.json({ success: true });
      } catch (error) {
        logger.error(`Failed to save ${this.providerDisplayName} API key`, {
          error,
        });
        return c.json({ error: "Failed to save API key" }, 500);
      }
    });

    // Remove credentials (logout)
    this.app.post("/logout", async (c) => {
      try {
        const body = await c.req.json().catch(() => ({}));
        const agentId = body.agentId || c.req.query("agentId");
        const queryToken = c.req.query("token");
        const authToken =
          typeof body.token === "string" ? body.token : queryToken;

        if (!agentId) {
          return c.json({ error: "Missing agentId" }, 400);
        }

        if (!this.isAuthorized(authToken, agentId)) {
          return c.json({ error: "Unauthorized" }, 401);
        }

        await this.authProfilesManager.deleteProviderProfiles(
          agentId,
          this.providerId,
          body.profileId
        );
        logger.info(
          `${this.providerDisplayName} credentials removed for agent ${agentId}`
        );

        return c.json({ success: true });
      } catch (error) {
        logger.error(
          `Failed to remove ${this.providerDisplayName} credentials`,
          { error }
        );
        return c.json({ error: "Failed to logout" }, 500);
      }
    });

    logger.info(`${this.providerDisplayName} base routes configured`);
  }
}
