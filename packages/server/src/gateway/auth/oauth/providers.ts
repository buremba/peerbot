/**
 * OAuth 2.0 Provider Configurations
 *
 * Centralizes OAuth provider settings for easy addition of new providers.
 * Each provider defines its endpoints, client credentials, and OAuth-specific settings.
 */

export interface OAuthProviderConfig {
  /** Unique provider identifier */
  id: string;
  /** Human-readable provider name */
  name: string;
  /** OAuth 2.0 client ID (public identifier) */
  clientId: string;
  /** OAuth 2.0 client secret (optional - not used for public clients with PKCE) */
  clientSecret?: string;
  /** Authorization endpoint URL */
  authUrl: string;
  /** Token exchange endpoint URL */
  tokenUrl: string;
  /** OAuth redirect URI */
  redirectUri: string;
  /** OAuth scopes (space-separated) */
  scope: string;
  /** Response type (default: "code") */
  responseType?: string;
  /** Grant type (default: "authorization_code") */
  grantType?: string;
  /** Custom headers to include in token requests */
  customHeaders?: Record<string, string>;
  /** Token endpoint auth method */
  tokenEndpointAuthMethod?:
    | "none"
    | "client_secret_post"
    | "client_secret_basic";
  /** Whether auth-code exchange must include refresh_token */
  requireRefreshToken?: boolean;
  /** Extra static query params to append to the authorize URL */
  extraAuthParams?: Record<string, string>;
  /** Extra static fields to include in the token exchange body */
  extraTokenParams?: Record<string, string | number>;
  /**
   * Encoding for the token-endpoint request body. RFC 6749 §4.1.3 mandates
   * `form` (`application/x-www-form-urlencoded`); some lenient providers also
   * accept `json`. Defaults to `json` to preserve existing behavior for
   * providers not explicitly set.
   */
  tokenRequestFormat?: "json" | "form";
  /**
   * The OAuth grant kind for this provider. Dispatches which grant strategy
   * runs the interactive flow: `authorization-code` (Claude — redirect + paste
   * `code#state`) or `device-code` (ChatGPT — show a user code + poll). This is
   * a pure DATA discriminator; the grant behavior lives behind `GrantStrategy`,
   * keyed on this value. Defaults to `authorization-code`.
   */
  grant?: "authorization-code" | "device-code";
  /**
   * The EXACT `authType` string persisted on the resulting profile. Must never
   * drift — `token-refresh-job.ts` matches refreshable profiles via a Set
   * membership on these literals (`"oauth"` = Claude, `"device-code"` =
   * ChatGPT). Defaults to `"oauth"`.
   */
  authType?: "oauth" | "device-code";
  /** Device-auth code-request endpoint (device-code grant only). */
  deviceCodeUrl?: string;
  /** Device-auth token-poll endpoint (device-code grant only). */
  deviceTokenUrl?: string;
  /** Device-flow redirect URI baked into the code exchange (device-code grant). */
  deviceRedirectUri?: string;
  /**
   * Poll HTTP status codes that mean "user hasn't authorized yet" (device-code
   * grant). Defaults to `[403, 404, 429]`.
   */
  pendingStatusCodes?: number[];
  /** Send `scope` in the refresh body (OpenAI requires it; Claude does not). */
  includeScopeInRefresh?: boolean;
  /**
   * What to do when a token response omits `refresh_token`. `preserve` keeps the
   * existing one (OpenAI doesn't always rotate); `require` throws (Claude — a
   * missing refresh token is a hard error). Defaults to `require`.
   */
  missingRefreshTokenPolicy?: "preserve" | "require";
  /** JWT claim path the accountId is decoded from (device-code grant). */
  accountIdClaimPath?: string;
  /** Env var that overrides `scope` at runtime (e.g. `OPENAI_OAUTH_SCOPE`). */
  scopeEnvVar?: string;
  /** Static `User-Agent` sent on token requests (OpenAI expects `reqwest/…`). */
  userAgent?: string;
}

/**
 * Claude OAuth Configuration
 *
 * Mirrors the public Claude Code CLI's subscription login flow
 * (`loginWithClaudeAi: true, inferenceOnly: true`). Anthropic's token endpoint
 * 429s any failed code exchange using this client_id, so we must match the
 * expected request shape exactly: claude.com authorize URL, the `code=true`
 * query flag, `user:inference` scope, and — critically — an
 * `application/x-www-form-urlencoded` token-exchange body (`tokenRequestFormat:
 * "form"`). The binary POSTs the exchange as form-encoded; sending JSON makes
 * Anthropic fail to parse the body and return
 * `invalid_grant: Invalid 'redirect_uri'`.
 *
 * Endpoints + request shape extracted from the current `@anthropic-ai/claude-code`
 * binary — Anthropic moved hosts from `claude.ai`/`console.anthropic.com` to
 * `claude.com`/`platform.claude.com` and the old hosts reject requests. The
 * genuine exchange body is `{grant_type, code, redirect_uri, client_id,
 * code_verifier, state}` with no `expires_in`.
 */
export const CLAUDE_PROVIDER: OAuthProviderConfig = {
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
  requireRefreshToken: true,
  extraAuthParams: { code: "true" },
  tokenRequestFormat: "form",
  grant: "authorization-code",
  authType: "oauth",
};

/**
 * ChatGPT (subscription login) OAuth configuration — DATA ONLY.
 *
 * OpenAI's device-auth handshake (`/api/accounts/deviceauth/*`) is its own JSON
 * API, not RFC 6749, so the device-code grant strategy drives
 * `ChatGPTDeviceCodeClient.requestDeviceCode` / `pollForToken` (which keep their
 * bespoke request shapes as subclass methods). Only the constants that used to
 * live as module-level literals in `device-code-client.ts` are migrated here so
 * the config is the single source of truth; the client still owns the handshake
 * METHODS.
 *
 * `authType: "device-code"` is the EXACT stored string — `token-refresh-job.ts`
 * keys refresh eligibility on it. `missingRefreshTokenPolicy: "preserve"` keeps
 * the stored refresh token when OpenAI omits it on a refresh (it doesn't always
 * rotate). `scopeEnvVar` mirrors the client's `OPENAI_OAUTH_SCOPE` override.
 */
export const CHATGPT_PROVIDER: OAuthProviderConfig = {
  id: "chatgpt",
  name: "ChatGPT",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authUrl: "https://auth.openai.com/oauth/authorize",
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
  responseType: "code",
  grantType: "authorization_code",
  tokenEndpointAuthMethod: "none",
  tokenRequestFormat: "form",
  grant: "device-code",
  authType: "device-code",
  deviceCodeUrl: "https://auth.openai.com/api/accounts/deviceauth/usercode",
  deviceTokenUrl: "https://auth.openai.com/api/accounts/deviceauth/token",
  deviceRedirectUri: "https://auth.openai.com/deviceauth/callback",
  pendingStatusCodes: [403, 404, 429],
  includeScopeInRefresh: true,
  missingRefreshTokenPolicy: "preserve",
  accountIdClaimPath: "https://api.openai.com/auth",
  scopeEnvVar: "OPENAI_OAUTH_SCOPE",
  userAgent: "reqwest/0.12.24",
};
