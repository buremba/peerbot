import { BaseOAuth2Client } from "./base-client.js";
import type { OAuthCredentials } from "./credentials.js";
import type { OAuthProviderConfig } from "./providers.js";

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in: number;
  scope?: string;
}

/**
 * Config-driven OAuth client for any provider
 * Extends BaseOAuth2Client with provider configuration
 *
 * Features:
 * - PKCE support (RFC 7636) for public client security
 * - Browser-like headers for anti-bot protection
 * - Configurable via OAuthProviderConfig
 */
export class OAuthClient extends BaseOAuth2Client {
  private config: OAuthProviderConfig;

  constructor(config: OAuthProviderConfig) {
    super(`${config.id ?? "oauth"}-client`);
    this.config = config;
  }

  /**
   * Build authorization URL with PKCE parameters
   */
  buildAuthUrl(
    state: string,
    codeVerifier: string,
    customRedirectUri?: string
  ): string {
    const codeChallenge = this.generateCodeChallenge(codeVerifier);
    const redirectUri = customRedirectUri || this.config.redirectUri;

    const url = new URL(this.config.authUrl);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", this.config.responseType || "code");
    url.searchParams.set("state", state);
    url.searchParams.set("scope", this.config.scope);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    for (const [k, v] of Object.entries(this.config.extraAuthParams ?? {})) {
      url.searchParams.set(k, v);
    }

    return url.toString();
  }

  /**
   * Exchange authorization code for access token using PKCE
   */
  async exchangeCodeForToken(
    code: string,
    codeVerifier: string,
    customRedirectUri?: string,
    state?: string
  ): Promise<OAuthCredentials> {
    const redirectUri = customRedirectUri || this.config.redirectUri;

    const body: Record<string, string | number> = {
      grant_type: this.config.grantType || "authorization_code",
      client_id: this.config.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      ...(this.config.extraTokenParams ?? {}),
    };

    // Include state if provided (required by Claude OAuth)
    if (state) {
      body.state = state;
    }

    // Add provider-specific custom headers
    const tokenData = await this.exchangeToken<OAuthTokenResponse>(
      this.config.tokenUrl,
      body,
      "json",
      this.config.customHeaders
    );

    const credentials = this.buildCredentials(tokenData);
    this.logger.info(
      `Token exchange successful, expires_in: ${tokenData.expires_in}s`,
      { scopes: credentials.scopes }
    );

    return credentials;
  }

  /**
   * Refresh access token using refresh token
   * Uses generic refresh method from base client with Claude-specific config
   */
  async refreshToken(refreshToken: string): Promise<OAuthCredentials> {
    const tokenData = await this.refreshTokenWithConfig<OAuthTokenResponse>(
      this.config.tokenUrl,
      this.config.clientId,
      refreshToken,
      {
        customHeaders: this.config.customHeaders,
        contentType: "json",
        tokenEndpointAuthMethod: this.config.tokenEndpointAuthMethod,
      }
    );

    const credentials = this.buildCredentials(tokenData, refreshToken);
    this.logger.info(
      `Token refresh successful, expires_in: ${tokenData.expires_in}s`
    );

    return credentials;
  }

  private buildCredentials(
    tokenData: {
      access_token: string;
      refresh_token?: string;
      token_type?: string;
      expires_in: number;
      scope?: string;
    },
    fallbackRefreshToken?: string
  ): OAuthCredentials {
    const expiresAt = this.calculateExpiresAt(tokenData.expires_in)!;
    const scopes = this.parseScopes(tokenData.scope);
    const refreshToken = tokenData.refresh_token ?? fallbackRefreshToken;

    if (!refreshToken && this.config.requireRefreshToken !== false) {
      throw new Error(
        `${this.config.name} OAuth response missing refresh token`
      );
    }

    return {
      accessToken: tokenData.access_token,
      refreshToken,
      tokenType: tokenData.token_type || "Bearer",
      expiresAt,
      scopes,
    };
  }

  /**
   * Get the provider configuration (useful for debugging)
   */
  getConfig(): OAuthProviderConfig {
    return { ...this.config };
  }
}
