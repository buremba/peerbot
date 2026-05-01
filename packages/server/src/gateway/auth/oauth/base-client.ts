import { createHash, randomBytes } from "node:crypto";
import { createLogger, type Logger } from "@lobu/core";

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
    return randomBytes(32).toString("base64url");
  }

  /**
   * Generate PKCE code challenge from verifier using SHA256
   * The challenge is sent in authorization request, verifier in token exchange
   */
  generateCodeChallenge(codeVerifier: string): string {
    return createHash("sha256").update(codeVerifier).digest("base64url");
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

      this.logger.debug(`Token exchange request`, {
        contentType,
        tokenUrl,
      });

      const response = await fetch(tokenUrl, {
        method: "POST",
        headers,
        body,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Token exchange failed: ${response.status}`, {
          errorText,
        });
        throw new Error(
          `Token exchange failed: ${response.status} ${response.statusText}`
        );
      }

      const responseContentType = response.headers.get("content-type") || "";
      let tokenData: any;

      // Parse response based on content type
      if (responseContentType.includes("application/json")) {
        tokenData = await response.json();
      } else {
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
      }

      // Check for OAuth error response
      if ("error" in tokenData) {
        throw new Error(
          `OAuth error: ${tokenData.error} - ${tokenData.error_description || ""}`
        );
      }

      if (!tokenData.access_token) {
        throw new Error("No access token in response");
      }

      this.logger.info(
        `Token exchange successful, expires_in: ${tokenData.expires_in}s`
      );

      return tokenData as T;
    } catch (error) {
      this.logger.error("Token exchange failed", { error });
      throw error;
    }
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
        this.logger.error(`Token refresh failed: ${response.status}`, {
          errorText,
        });
        throw new Error(
          `Token refresh failed: ${response.status} ${response.statusText}`
        );
      }

      const tokenData = (await response.json()) as any;

      if ("error" in tokenData) {
        throw new Error(
          `OAuth error: ${tokenData.error} - ${tokenData.error_description || ""}`
        );
      }

      if (!tokenData.access_token) {
        throw new Error("No access token in refresh response");
      }

      this.logger.info(
        `Token refresh successful, expires_in: ${tokenData.expires_in}s`
      );

      return tokenData as T;
    } catch (error) {
      this.logger.error("Token refresh failed", { error });
      throw error;
    }
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
