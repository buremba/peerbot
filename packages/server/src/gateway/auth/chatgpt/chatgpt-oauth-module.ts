import type { ModelOption } from "@lobu/core";
import { BaseProviderModule } from "../base-provider-module.js";
import type { AuthProfilesManager } from "../settings/auth-profiles-manager.js";
import { fetchModelOptions } from "../utils/fetch-model-options.js";
import { ChatGPTDeviceCodeClient } from "./device-code-client.js";

/**
 * ChatGPT provider module — runtime credential surface for the ChatGPT
 * (subscription login) provider. The OAuth device-code FLOW now lives in the
 * generic org routes (`grant-strategy.ts` + `agent-routes.ts`); this module
 * keeps only the provider-runtime methods: the codex-backend credential
 * placeholder, model listing, CLI backend config, and account-id extraction.
 */
export class ChatGPTOAuthModule extends BaseProviderModule {
  private deviceCodeClient: ChatGPTDeviceCodeClient;

  constructor(authProfilesManager: AuthProfilesManager) {
    super(
      {
        providerId: "chatgpt",
        providerDisplayName: "ChatGPT (subscription login)",
        providerIconUrl:
          "https://www.google.com/s2/favicons?domain=chatgpt.com&sz=128",
        credentialEnvVarName: "OPENAI_API_KEY",
        secretEnvVarNames: ["OPENAI_API_KEY"],
        slug: "openai-codex",
        upstreamBaseUrl: "https://chatgpt.com/backend-api",
        // Dedicated key — must NOT be "OPENAI_BASE_URL". The config-driven
        // `openai` provider (sdkCompat "openai", api.openai.com) also emits
        // OPENAI_BASE_URL; sharing the key let an unguarded merge clobber it so
        // an `openai/<model>` request egressed to chatgpt.com/backend-api (403
        // without a ChatGPT session). Keep this provider's base URL under its
        // own key so the two never collide.
        baseUrlEnvVarName: "OPENAI_CODEX_BASE_URL",
        authType: "device-code",
        supportedAuthTypes: ["device-code", "api-key"],
        apiKeyInstructions:
          'Enter your <a href="https://platform.openai.com/api-keys" target="_blank" class="text-blue-600 underline">OpenAI API key</a>:',
        apiKeyPlaceholder: "sk-...",
        catalogDescription:
          "Sign in with your ChatGPT Plus/Pro subscription (device code). No API key; uses your subscription, not metered API billing.",
      },
      authProfilesManager
    );
    // Preserve existing module name
    this.name = "chatgpt-oauth";
    this.deviceCodeClient = new ChatGPTDeviceCodeClient();
  }

  async buildCredentialPlaceholder(agentId: string): Promise<string> {
    const profile = await this.authProfilesManager.getBestProfile(
      agentId,
      this.providerId
    );
    // Try metadata first, then extract from the stored credential JWT
    let accountId = profile?.metadata?.accountId as string | undefined;
    if (!accountId && profile?.credential) {
      accountId = this.deviceCodeClient.extractAccountId(profile.credential);
    }
    if (!accountId) return "lobu-proxy";

    // Minimal JWT with the chatgpt_account_id claim.
    // Not a valid credential — only used by the codex backend to extract accountId.
    const header = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" })
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: accountId },
      })
    ).toString("base64url");
    return `${header}.${payload}.placeholder`;
  }

  getCliBackendConfig() {
    return {
      name: "codex",
      command: "npx",
      args: ["-y", "acpx@latest", "codex", "--quiet"],
      modelArg: "--model",
    };
  }

  async getModelOptions(
    agentId: string,
    _userId: string
  ): Promise<ModelOption[]> {
    const token = await this.getCredential(agentId);
    if (!token) return [];

    return fetchModelOptions<{
      models?: Array<{ slug?: string; title?: string }>;
    }>({
      url: "https://chatgpt.com/backend-api/models",
      headers: { Authorization: `Bearer ${token}` },
      prefix: "openai-codex",
      pick: (payload) =>
        (payload.models || []).map((m) => {
          const id = m.slug?.trim();
          return id ? { id, label: m.title?.trim() || id } : null;
        }),
    });
  }

}
