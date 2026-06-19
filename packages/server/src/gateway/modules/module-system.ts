import type { CliBackendConfig, ModelOption } from "@lobu/core";
import { type ModuleInterface, moduleRegistry } from "@lobu/core";
import type { ProviderCredentialContext } from "../embedded.js";

interface OrchestratorModule extends ModuleInterface {
  buildEnvVars(
    agentId: string,
    baseEnv: Record<string, string>,
    context?: ProviderCredentialContext
  ): Promise<Record<string, string>>;
}

export interface ProviderUpstreamConfig {
  slug: string;
  upstreamBaseUrl: string;
  /**
   * Header used to present an API-KEY credential to this upstream. Anthropic
   * requires `x-api-key` and 401s ("invalid bearer token") when an `sk-ant`
   * key is sent as `Authorization: Bearer` — which is the OpenAI-compatible
   * default every other provider uses. OAuth credentials always use
   * `Authorization: Bearer` regardless of this setting. Omit for Bearer.
   */
  apiKeyHeader?: "authorization" | "x-api-key";
}

export interface ModelProviderModule extends OrchestratorModule {
  providerId: string;
  providerDisplayName: string;
  providerIconUrl?: string;
  authType?: "oauth" | "device-code" | "api-key";
  supportedAuthTypes?: ("oauth" | "device-code" | "api-key")[];
  apiKeyInstructions?: string;
  apiKeyPlaceholder?: string;
  catalogDescription?: string;
  catalogVisible?: boolean;
  getSecretEnvVarNames(): string[];
  getCredentialEnvVarName(): string;
  /**
   * Subset of `getSecretEnvVarNames()` whose values are Bearer/OAuth-style
   * tokens (e.g. `CLAUDE_CODE_OAUTH_TOKEN`) rather than API keys. Lets the
   * system-key resolver classify a resolved env credential as `"oauth"` so the
   * secret proxy presents it as `Authorization: Bearer`. Default: none.
   */
  getBearerCredentialEnvVarNames?(): string[];
  getUpstreamConfig?(): ProviderUpstreamConfig | null;
  hasCredentials(
    agentId: string,
    context?: ProviderCredentialContext
  ): Promise<boolean>;
  hasSystemKey(): boolean;
  getProxyBaseUrlMappings(
    proxyUrl: string,
    agentId?: string,
    context?: ProviderCredentialContext
  ): Record<string, string>;
  injectSystemKeyFallback(
    envVars: Record<string, string>
  ): Record<string, string>;
  getApp?(): any;
  getModelOptions?(agentId: string, userId: string): Promise<ModelOption[]>;
  getCliBackendConfig?(): CliBackendConfig | null;
  buildCredentialPlaceholder?(
    agentId: string,
    context?: ProviderCredentialContext
  ): Promise<string> | string;
  startDeviceCode?(agentId: string): Promise<{
    userCode: string;
    deviceAuthId: string;
    interval: number;
    verificationUrl?: string;
  }>;
  pollDeviceCode?(
    agentId: string,
    userId: string,
    payload: { deviceAuthId: string; userCode: string }
  ): Promise<{
    status: "pending" | "success";
    error?: string;
    accountId?: string;
  }>;
}

export abstract class BaseModule implements OrchestratorModule {
  abstract name: string;
  abstract isEnabled(): boolean;

  async init(): Promise<void> {
    // no-op
  }

  registerEndpoints(_app: any): void {
    // no-op
  }

  async buildEnvVars(
    _agentId: string,
    baseEnv: Record<string, string>,
    _context?: ProviderCredentialContext
  ): Promise<Record<string, string>> {
    return baseEnv;
  }

  async getModelOptions(
    _agentId: string,
    _userId: string
  ): Promise<ModelOption[]> {
    return [];
  }
}

export function getOrchestratorModules(): OrchestratorModule[] {
  return moduleRegistry
    .getModules()
    .filter((m): m is OrchestratorModule => "buildEnvVars" in m);
}

export function getModelProviderModules(): ModelProviderModule[] {
  return moduleRegistry
    .getModules()
    .filter(
      (m): m is ModelProviderModule =>
        "providerId" in m && "getSecretEnvVarNames" in m
    );
}
