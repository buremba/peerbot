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
  /** Use PKCE for public clients (RFC 7636) */
  usePKCE: boolean;
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
}

/**
 * Claude OAuth Configuration
 *
 * Mirrors the public Claude Code CLI's subscription login flow
 * (`loginWithClaudeAi: true, inferenceOnly: true`). Anthropic's token endpoint
 * 429s any failed code exchange using this client_id, so we must match the
 * expected request shape exactly: claude.com authorize URL, the `code=true`
 * query flag, `user:inference` scope, and a long `expires_in` in the exchange.
 *
 * Endpoints extracted from the current `@anthropic-ai/claude-code` binary —
 * Anthropic moved them from `claude.ai`/`console.anthropic.com` to
 * `claude.com`/`platform.claude.com` and the old hosts reject requests.
 */
export const CLAUDE_PROVIDER: OAuthProviderConfig = {
  id: "claude",
  name: "Claude",
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authUrl: "https://claude.com/cai/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  redirectUri: "https://platform.claude.com/oauth/code/callback",
  scope: "user:inference",
  usePKCE: true,
  responseType: "code",
  grantType: "authorization_code",
  tokenEndpointAuthMethod: "none",
  requireRefreshToken: true,
  extraAuthParams: { code: "true" },
  extraTokenParams: { expires_in: 31536000 },
};
