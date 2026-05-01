import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import type { ProviderCredentialContext } from "../embedded.js";
import {
  BaseModule,
  type ModelProviderModule,
  type ProviderUpstreamConfig,
} from "../modules/module-system.js";
import { resolveEnv } from "./mcp/string-substitution.js";
import type { AuthProfilesManager } from "./settings/auth-profiles-manager.js";

const logger = createLogger("base-provider-module");

interface BaseProviderConfig {
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
 * and Hono app management. Save-key and logout routes are handled by the
 * parameterized auth router in gateway.ts.
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
    const { slug, upstreamBaseUrl, baseUrlEnvVarName } = this.providerConfig;
    if (!slug || !upstreamBaseUrl) return null;
    // Check env for base URL override (e.g., ANTHROPIC_BASE_URL=https://api.z.ai)
    const envOverride = baseUrlEnvVarName
      ? resolveEnv(baseUrlEnvVarName)
      : undefined;
    return { slug, upstreamBaseUrl: envOverride || upstreamBaseUrl };
  }

  async hasCredentials(
    agentId: string,
    context?: ProviderCredentialContext
  ): Promise<boolean> {
    return this.authProfilesManager.hasProviderProfiles(
      agentId,
      this.providerId,
      context
    );
  }

  hasSystemKey(): boolean {
    const envVar =
      this.providerConfig.systemEnvVarName ||
      this.providerConfig.credentialEnvVarName;
    return !!resolveEnv(envVar);
  }

  /**
   * Build the agent/user path suffix used for agent-scoped proxy routing.
   * Returns an empty string when no agentId is provided.
   */
  protected buildAgentScopedSuffix(
    agentId?: string,
    context?: ProviderCredentialContext
  ): string {
    if (!agentId) return "";
    const agentPath = `/a/${encodeURIComponent(agentId)}`;
    if (!context?.userId) return agentPath;
    return `${agentPath}/u/${encodeURIComponent(context.userId)}`;
  }

  protected buildAgentScopedProxyUrl(
    proxyUrl: string,
    slug: string,
    agentId?: string,
    context?: ProviderCredentialContext
  ): string {
    return `${proxyUrl}/${slug}${this.buildAgentScopedSuffix(agentId, context)}`;
  }

  getProxyBaseUrlMappings(
    proxyUrl: string,
    agentId?: string,
    context?: ProviderCredentialContext
  ): Record<string, string> {
    const { slug, baseUrlEnvVarName, credentialEnvVarName } =
      this.providerConfig;
    if (!slug) return {};
    const envVar =
      baseUrlEnvVarName || credentialEnvVarName.replace("_KEY", "_BASE_URL");
    return {
      [envVar]: this.buildAgentScopedProxyUrl(proxyUrl, slug, agentId, context),
    };
  }

  injectSystemKeyFallback(
    envVars: Record<string, string>
  ): Record<string, string> {
    const credVar = this.providerConfig.credentialEnvVarName;
    if (!envVars[credVar]) {
      const sysVar = this.providerConfig.systemEnvVarName || credVar;
      const systemKey = resolveEnv(sysVar);
      if (systemKey) {
        envVars[credVar] = systemKey;
      }
    }
    return envVars;
  }

  async buildEnvVars(
    agentId: string,
    envVars: Record<string, string>,
    context?: ProviderCredentialContext
  ): Promise<Record<string, string>> {
    const credVar = this.providerConfig.credentialEnvVarName;
    if (!envVars[credVar]) {
      const profile = await this.authProfilesManager.getBestProfile(
        agentId,
        this.providerId,
        undefined,
        context
      );
      const credential = profile && context?.userId
        ? await this.authProfilesManager.ensureFreshCredential(profile, {
            userId: context.userId,
            agentId,
          })
        : profile?.credential;
      if (credential) {
        logger.info(
          `Injecting ${credVar} for agent ${agentId} (${this.providerId})`
        );
        envVars[credVar] = credential;
      }
    }
    return envVars;
  }

  getApp(): Hono {
    return this.app;
  }

  protected async getCredential(
    agentId: string,
    context?: ProviderCredentialContext
  ): Promise<string | null> {
    const profile = await this.authProfilesManager.getBestProfile(
      agentId,
      this.providerId,
      undefined,
      context
    );
    const credential = profile && context?.userId
      ? await this.authProfilesManager.ensureFreshCredential(profile, {
          userId: context.userId,
          agentId,
        })
      : profile?.credential;
    if (credential) {
      return credential;
    }
    const sysVar =
      this.providerConfig.systemEnvVarName ||
      this.providerConfig.credentialEnvVarName;
    return process.env[sysVar] || null;
  }

  /** Build a structured placeholder for proxy mode (default: "lobu-proxy"). */
  buildCredentialPlaceholder(
    _agentId: string,
    _context?: ProviderCredentialContext
  ): Promise<string> | string {
    return "lobu-proxy";
  }

  /** Override in subclasses to add provider-specific routes. */
  protected setupRoutes(): void {
    // Default: no extra routes
  }
}
