import type { AuthProfile } from "@lobu/core";

export type EmbeddedAuthProvider =
  import("./routes/public/settings-auth.js").AuthProvider;

export interface ProviderCredentialContext {
  userId?: string;
  conversationId?: string;
  channelId?: string;
  deploymentName?: string;
  platform?: string;
  connectionId?: string;
  /**
   * The worker's JWT, when the caller is a worker. Providers whose gateway
   * routes authenticate via worker auth (e.g. Bedrock) use this as the
   * credential/placeholder handed back to the runtime so the OpenAI SDK
   * sends `Authorization: Bearer <workerToken>` on upstream calls.
   */
  workerToken?: string;
}

export interface RuntimeProviderCredentialLookup
  extends ProviderCredentialContext {
  agentId: string;
  provider: string;
  model?: string;
}

export interface RuntimeProviderCredentialResult {
  credential?: string;
  credentialRef?: string;
  authType?: AuthProfile["authType"];
  label?: string;
  metadata?: AuthProfile["metadata"];
}

export type RuntimeProviderCredentialResolver = (
  input: RuntimeProviderCredentialLookup
) =>
  | Promise<RuntimeProviderCredentialResult | null | undefined>
  | RuntimeProviderCredentialResult
  | null
  | undefined;
