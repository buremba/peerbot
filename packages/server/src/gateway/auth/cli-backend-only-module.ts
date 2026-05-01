import type { ProviderCredentialContext } from "../embedded.js";
import { BaseProviderModule } from "./base-provider-module.js";
import type { AuthProfilesManager } from "./settings/auth-profiles-manager.js";

interface CliBackendOnlyConfig {
  providerId: string;
  providerDisplayName: string;
  providerIconUrl: string;
  catalogDescription?: string;
  catalogVisible?: boolean;
}

/**
 * Base class for providers that exist solely to register a CLI backend
 * (acpx-style sub-agent shell-out). They do not own any lobu-managed
 * credential or env var — the underlying CLI reads its own auth from the
 * host filesystem (e.g. `~/.gemini/oauth_creds.json`,
 * `~/.codex/auth.json`).
 *
 * Subclasses only need to implement `getCliBackendConfig()` and
 * `getModelOptions()`. Everything credential-related is intentionally
 * inert.
 */
export abstract class CliBackendOnlyModule extends BaseProviderModule {
  constructor(
    config: CliBackendOnlyConfig,
    authProfilesManager: AuthProfilesManager
  ) {
    super(
      {
        ...config,
        credentialEnvVarName: "",
        secretEnvVarNames: [],
        authType: "oauth",
      },
      authProfilesManager
    );
  }

  override hasSystemKey(): boolean {
    return false;
  }

  override async hasCredentials(
    _agentId: string,
    _context?: ProviderCredentialContext
  ): Promise<boolean> {
    return false;
  }

  override injectSystemKeyFallback(
    envVars: Record<string, string>
  ): Record<string, string> {
    return envVars;
  }

  override async buildEnvVars(
    _agentId: string,
    envVars: Record<string, string>,
    _context?: ProviderCredentialContext
  ): Promise<Record<string, string>> {
    return envVars;
  }

  override getProxyBaseUrlMappings(
    _proxyUrl: string,
    _agentId?: string,
    _context?: ProviderCredentialContext
  ): Record<string, string> {
    return {};
  }
}
