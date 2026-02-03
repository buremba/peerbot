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
}

/**
 * Claude AI OAuth Configuration
 * - Public client (no client secret)
 * - Uses PKCE for security
 * - Requires browser-like headers (anti-bot protection)
 */
export const CLAUDE_PROVIDER: OAuthProviderConfig = {
  id: "claude",
  name: "Claude AI",
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://console.anthropic.com/v1/oauth/token",
  redirectUri: "https://console.anthropic.com/oauth/code/callback",
  scope: "user:inference",
  usePKCE: true,
  responseType: "code",
  grantType: "authorization_code",
  tokenEndpointAuthMethod: "none",
  customHeaders: {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://claude.ai/",
    Origin: "https://claude.ai",
  },
};

/**
 * Registry of all OAuth providers
 * Add new providers here to make them available throughout the system
 */
export const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  claude: CLAUDE_PROVIDER,
};
