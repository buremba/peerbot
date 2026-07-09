/**
 * Inline OAuth configs for unit tests (mirrors config/providers.json oauth blocks).
 * Production loads these from providers.json via loadOAuthProvidersFromConfigs.
 */
import type { OAuthProviderConfig } from "../providers.js";

export const TEST_CLAUDE_OAUTH: OAuthProviderConfig = {
  id: "claude",
  name: "Claude",
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authUrl: "https://claude.com/cai/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  redirectUri: "https://platform.claude.com/oauth/code/callback",
  scope: "user:inference",
  responseType: "code",
  grantType: "authorization_code",
  tokenEndpointAuthMethod: "none",
  extraAuthParams: { code: "true" },
  tokenRequestFormat: "form",
  grant: "authorization-code",
  authType: "oauth",
};

export const TEST_CHATGPT_OAUTH: OAuthProviderConfig = {
  id: "chatgpt",
  name: "ChatGPT",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  tokenUrl: "https://auth.openai.com/oauth/token",
  redirectUri: "https://auth.openai.com/deviceauth/callback",
  scope: [
    "openid",
    "profile",
    "email",
    "offline_access",
    "api.model.read",
    "api.model.request",
    "api.model.image.request",
    "api.model.audio.request",
  ].join(" "),
  tokenEndpointAuthMethod: "none",
  tokenRequestFormat: "form",
  grant: "openai-device-auth",
  authType: "device-code",
  deviceCodeUrl: "https://auth.openai.com/api/accounts/deviceauth/usercode",
  deviceTokenUrl: "https://auth.openai.com/api/accounts/deviceauth/token",
  deviceRedirectUri: "https://auth.openai.com/deviceauth/callback",
  defaultVerificationUrl: "https://auth.openai.com/codex/device",
  includeScopeInRefresh: true,
  accountIdClaimPath: "https://api.openai.com/auth",
  scopeEnvVar: "OPENAI_OAUTH_SCOPE",
  userAgent: "reqwest/0.12.24",
};

export const TEST_XAI_OAUTH: OAuthProviderConfig = {
  id: "xai",
  name: "xAI (SuperGrok)",
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  tokenUrl: "https://auth.x.ai/oauth2/token",
  scope: "openid profile email offline_access grok-cli:access api:access",
  tokenEndpointAuthMethod: "none",
  tokenRequestFormat: "form",
  grant: "device-code",
  authType: "device-code",
  deviceCodeUrl: "https://auth.x.ai/oauth2/device/code",
  defaultVerificationUrl: "https://accounts.x.ai/oauth2/device",
};

export const TEST_OAUTH_REGISTRY = [
  TEST_CLAUDE_OAUTH,
  TEST_CHATGPT_OAUTH,
  TEST_XAI_OAUTH,
] as const;
