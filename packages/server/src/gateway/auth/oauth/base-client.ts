import { createLogger, type Logger } from "@lobu/core";
import {
  generateCodeChallenge as pkceCodeChallenge,
  generateCodeVerifier as pkceCodeVerifier,
} from "../../../utils/pkce.js";

/**
 * Base OAuth2 client with shared token exchange and refresh logic
 * Supports standard OAuth 2.0 flows including PKCE (RFC 7636)
 * Subclasses customize authorization URL building and request formatting
 */
export abstract class BaseOAuth2Client {
  protected logger: Logger;

  constructor(loggerName: string) {
    this.logger = createLogger(loggerName);
  }

  // ============================================================================
  // PKCE Support (RFC 7636) - For public clients
  // ============================================================================

  /**
   * Generate PKCE code verifier (43-128 characters, base64url encoded)
   * Used for public OAuth clients (mobile apps, CLIs, SPAs)
   */
  generateCodeVerifier(): string {
    return pkceCodeVerifier();
  }

  /**
   * Generate PKCE code challenge from verifier using SHA256
   * The challenge is sent in authorization request, verifier in token exchange
   */
  generateCodeChallenge(codeVerifier: string): string {
    return pkceCodeChallenge(codeVerifier);
  }

  // ============================================================================
  // Generic OAuth Token Operations
  // ============================================================================

  /**
   * Generic refresh token method using provider configuration
   * Supports both public clients (PKCE) and confidential clients (with secret)
   *
   * @param tokenUrl - Token endpoint URL
   * @param clientId - OAuth client ID
   * @param refreshToken - Refresh token from initial authorization
   * @param options - Optional parameters (client secret, custom headers, content type)
   */
  async refreshTokenWithConfig<T>(
    tokenUrl: string,
    clientId: string,
    refreshToken: string,
    options?: {
      clientSecret?: string;
      customHeaders?: Record<string, string>;
      contentType?: "json" | "form";
      tokenEndpointAuthMethod?: string;
    }
  ): Promise<T> {
    const body: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    };

    // Add client_secret if not using PKCE (tokenEndpointAuthMethod !== "none")
    if (options?.clientSecret && options?.tokenEndpointAuthMethod !== "none") {
      body.client_secret = options.clientSecret;
    }

    return this.refreshAccessToken<T>(
      tokenUrl,
      body,
      options?.contentType || "json",
      options?.customHeaders
    );
  }

  // ============================================================================
  // Low-level HTTP Operations (protected for subclasses)
  // ============================================================================

  /**
   * Shared POST to a token endpoint. Serializes the body per `contentType`,
   * sets the matching `Content-Type` header (merged after any caller headers so
   * it always wins), checks `response.ok`, parses the token response, and
   * validates for OAuth errors / a present `access_token`. The two public
   * operations differ only in their log prefix and whether a form-encoded
   * response body is accepted (`parseFormResponse`), so both delegate here.
   */
  private async postTokenRequest<T>(
    tokenUrl: string,
    requestBody: Record<string, string | number> | URLSearchParams,
    contentType: "json" | "form",
    additionalHeaders: Record<string, string> | undefined,
    opts: { label: string; failPrefix: string; parseFormResponse: boolean }
  ): Promise<T> {
    try {
      const body =
        contentType === "json"
          ? JSON.stringify(requestBody)
          : requestBody instanceof URLSearchParams
            ? requestBody.toString()
            : new URLSearchParams(
                requestBody as Record<string, string>
              ).toString();

      const headers: Record<string, string> = {
        Accept: "application/json",
        ...additionalHeaders,
      };

      if (contentType === "json") {
        headers["Content-Type"] = "application/json";
      } else {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      }

      const response = await fetch(tokenUrl, {
        method: "POST",
        headers,
        body,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`${opts.failPrefix}: ${response.status}`, {
          errorText,
        });
        throw new Error(
          `${opts.failPrefix}: ${response.status} ${response.statusText}`
        );
      }

      let tokenData: any;
      const responseContentType = response.headers.get("content-type") || "";
      if (
        opts.parseFormResponse &&
        !responseContentType.includes("application/json")
      ) {
        // Handle form-encoded responses (e.g., some OAuth providers)
        const text = await response.text();
        const params = new URLSearchParams(text);
        tokenData = {
          access_token: params.get("access_token") || "",
          token_type: params.get("token_type") || "Bearer",
          expires_in: params.get("expires_in")
            ? parseInt(params.get("expires_in")!, 10)
            : undefined,
          refresh_token: params.get("refresh_token") || undefined,
          scope: params.get("scope") || undefined,
        };
      } else {
        tokenData = await response.json();
      }

      if ("error" in tokenData) {
        throw new Error(
          `OAuth error: ${tokenData.error} - ${tokenData.error_description || ""}`
        );
      }

      if (!tokenData.access_token) {
        throw new Error(`No access token in ${opts.label} response`);
      }

      this.logger.info(
        `${opts.label} successful, expires_in: ${tokenData.expires_in}s`
      );

      return tokenData as T;
    } catch (error) {
      this.logger.error(`${opts.label} failed`, { error });
      throw error;
    }
  }

  /**
   * Common token exchange implementation
   * Subclasses must implement buildTokenExchangeRequest
   */
  protected async exchangeToken<T>(
    tokenUrl: string,
    requestBody: Record<string, string | number> | URLSearchParams,
    contentType: "json" | "form" = "json",
    additionalHeaders?: Record<string, string>
  ): Promise<T> {
    this.logger.info(`Exchanging code for token at ${tokenUrl}`, {
      contentType,
    });
    return this.postTokenRequest<T>(
      tokenUrl,
      requestBody,
      contentType,
      additionalHeaders,
      {
        label: "Token exchange",
        failPrefix: "Token exchange failed",
        parseFormResponse: true,
      }
    );
  }

  /**
   * Common token refresh implementation
   * Subclasses must implement buildRefreshRequest
   */
  protected async refreshAccessToken<T>(
    tokenUrl: string,
    requestBody: Record<string, string> | URLSearchParams,
    contentType: "json" | "form" = "json",
    additionalHeaders?: Record<string, string>
  ): Promise<T> {
    this.logger.info(`Refreshing token at ${tokenUrl}`);
    return this.postTokenRequest<T>(
      tokenUrl,
      requestBody,
      contentType,
      additionalHeaders,
      {
        label: "Token refresh",
        failPrefix: "Token refresh failed",
        parseFormResponse: false,
      }
    );
  }

  /**
   * Calculate token expiration timestamp
   */
  protected calculateExpiresAt(expiresIn?: number): number | undefined {
    return expiresIn ? Date.now() + expiresIn * 1000 : undefined;
  }

  /**
   * Parse scopes from string or array
   */
  protected parseScopes(scope?: string): string[] {
    return scope ? scope.split(" ") : [];
  }
}
