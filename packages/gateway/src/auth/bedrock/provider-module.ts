import type { ConfigProviderMeta } from "@lobu/core";
import type { ModelOption } from "../../modules/module-system";
import type { BedrockModelCatalog } from "../../services/bedrock-model-catalog";
import { BaseProviderModule } from "../base-provider-module";
import type { AuthProfilesManager } from "../settings/auth-profiles-manager";

const BEDROCK_PROXY_CREDENTIAL = "bedrock-proxy";
const BEDROCK_ROUTE_PREFIX = "/api/bedrock/openai";
const BEDROCK_BASE_URL_ENV = "AMAZON_BEDROCK_BASE_URL";
const BEDROCK_CREDENTIAL_ENV = "AMAZON_BEDROCK_API_KEY";
const DEFAULT_BEDROCK_MODEL = "amazon.nova-lite-v1:0";

function hasAwsCredentialHint(): boolean {
  // Explicit opt-in always wins
  if (process.env.BEDROCK_ENABLED === "true") return true;

  // Only auto-enable when an actual credential source is present.
  // Region alone is not sufficient — it doesn't provide authentication.
  return Boolean(
    process.env.AWS_PROFILE ||
      process.env.AWS_ACCESS_KEY_ID ||
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
      process.env.AWS_BEARER_TOKEN_BEDROCK
  );
}

export class BedrockProviderModule extends BaseProviderModule {
  constructor(
    authProfilesManager: AuthProfilesManager,
    private readonly modelCatalog: BedrockModelCatalog
  ) {
    super(
      {
        providerId: "amazon-bedrock",
        providerDisplayName: "Amazon Bedrock",
        providerIconUrl:
          "https://www.google.com/s2/favicons?domain=aws.amazon.com&sz=128",
        credentialEnvVarName: BEDROCK_CREDENTIAL_ENV,
        secretEnvVarNames: [BEDROCK_CREDENTIAL_ENV],
        authType: "api-key",
        apiKeyInstructions:
          "No end-user API key is required. Run the gateway on AWS with IAM credentials available to the gateway process and set AWS_REGION (or AWS_DEFAULT_REGION).",
        apiKeyPlaceholder: "Not required",
        catalogDescription:
          "Use Amazon Bedrock models through gateway-owned AWS credentials",
      },
      authProfilesManager
    );
    this.name = "amazon-bedrock-provider";
  }

  override hasSystemKey(): boolean {
    return hasAwsCredentialHint();
  }

  override injectSystemKeyFallback(
    envVars: Record<string, string>
  ): Record<string, string> {
    if (!envVars[BEDROCK_CREDENTIAL_ENV]) {
      envVars[BEDROCK_CREDENTIAL_ENV] = BEDROCK_PROXY_CREDENTIAL;
    }
    return envVars;
  }

  override async buildEnvVars(
    _agentId: string,
    envVars: Record<string, string>
  ): Promise<Record<string, string>> {
    if (!envVars[BEDROCK_CREDENTIAL_ENV]) {
      envVars[BEDROCK_CREDENTIAL_ENV] = BEDROCK_PROXY_CREDENTIAL;
    }
    return envVars;
  }

  override getProxyBaseUrlMappings(
    proxyUrl: string,
    agentId?: string
  ): Record<string, string> {
    const gatewayBase = proxyUrl.replace(/\/api\/proxy\/?$/, "");
    const base = `${gatewayBase}${BEDROCK_ROUTE_PREFIX}`;
    return {
      [BEDROCK_BASE_URL_ENV]: agentId ? `${base}/a/${agentId}` : base,
    };
  }

  buildCredentialPlaceholder(): string {
    return BEDROCK_PROXY_CREDENTIAL;
  }

  getProviderMetadata(): ConfigProviderMeta {
    return {
      sdkCompat: "openai",
      defaultModel: DEFAULT_BEDROCK_MODEL,
      baseUrlEnvVar: BEDROCK_BASE_URL_ENV,
    };
  }

  async getModelOptions(
    _agentId: string,
    _userId: string
  ): Promise<ModelOption[]> {
    const models = await this.modelCatalog.listModelOptions();
    return models.map((model) => ({
      value: `amazon-bedrock/${model.id}`,
      label: model.label,
    }));
  }
}
