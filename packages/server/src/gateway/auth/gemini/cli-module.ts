import type { ModelOption } from "../../modules/module-system.js";
import { CliBackendOnlyModule } from "../cli-backend-only-module.js";
import type { AuthProfilesManager } from "../settings/auth-profiles-manager.js";

/**
 * Gemini CLI provider module — exposes Google's `gemini` CLI as a sub-agent
 * shell-out via acpx. The agent (running on a different primary model) can
 * Bash to `npx -y acpx@latest gemini "<prompt>"` for delegated tasks.
 *
 * This is **not** a primary-model path. The gemini CLI is invoked as a
 * subprocess and reads its OAuth credentials from `~/.gemini/oauth_creds.json`
 * locally — lobu doesn't proxy or refresh those credentials. Credential
 * management is the user's responsibility (run `gemini auth login` once on
 * the host that runs the worker).
 *
 * For Gemini *as a primary model*, use the AI Studio API key (`gemini`
 * provider in `config/providers.json`) or OpenRouter — both stable HTTP
 * paths that don't depend on the reverse-engineered Code Assist API.
 */
export class GeminiCliModule extends CliBackendOnlyModule {
  constructor(authProfilesManager: AuthProfilesManager) {
    super(
      {
        providerId: "gemini-cli",
        providerDisplayName: "Gemini CLI",
        providerIconUrl:
          "https://www.google.com/s2/favicons?domain=gemini.google.com&sz=128",
        catalogDescription:
          "Google's gemini CLI as a sub-agent shell-out (uses your local ~/.gemini OAuth)",
      },
      authProfilesManager
    );
    this.name = "gemini-cli";
  }

  getCliBackendConfig() {
    return {
      name: "gemini-cli",
      command: "npx",
      args: ["-y", "acpx@latest", "gemini"],
      modelArg: "--model",
      sessionArg: "--session",
    };
  }

  override async getModelOptions(): Promise<ModelOption[]> {
    return [
      { value: "gemini-cli/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { value: "gemini-cli/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    ];
  }
}
