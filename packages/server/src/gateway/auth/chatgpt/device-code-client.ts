import { BaseOAuth2Client } from "../oauth/base-client.js";
import type { OAuthCredentials } from "../oauth/credentials.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_CODE_URL =
  "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL =
  "https://auth.openai.com/api/accounts/deviceauth/token";
const TOKEN_EXCHANGE_URL = "https://auth.openai.com/oauth/token";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const OAUTH_SCOPE =
  process.env.OPENAI_OAUTH_SCOPE ||
  [
    "openid",
    "profile",
    "email",
    "offline_access",
    "api.model.read",
    "api.model.request",
    "api.model.image.request",
    "api.model.audio.request",
  ].join(" ");
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const TOKEN_USER_AGENT = "reqwest/0.12.24";
const DEVICE_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": TOKEN_USER_AGENT,
};

interface DeviceCodeResponse {
  userCode: string;
  deviceAuthId: string;
  interval: number;
}

interface DeviceTokenResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  accountId?: string;
}

/**
 * Client for OpenAI device code authentication flow.
 * Based on sub-bridge's device code implementation.
 *
 * Extends {@link BaseOAuth2Client} so the standard OAuth token exchange and
 * refresh ride the shared `exchangeToken` / `refreshAccessToken` HTTP plumbing.
 * The device-auth handshake (`/api/accounts/deviceauth/*`) is OpenAI's own JSON
 * API — not RFC 6749 — so those two requests keep their bespoke JSON shape here.
 */
export class ChatGPTDeviceCodeClient extends BaseOAuth2Client {
  constructor() {
    super("chatgpt-device-code");
  }

  /**
   * Request a device code from OpenAI.
   * Returns user_code for display and device_auth_id for polling.
   */
  async requestDeviceCode(): Promise<DeviceCodeResponse> {
    const response = await fetch(DEVICE_CODE_URL, {
      method: "POST",
      headers: DEVICE_HEADERS,
      body: JSON.stringify({
        client_id: CLIENT_ID,
        scope: OAUTH_SCOPE,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      this.logger.error("Device code request failed", {
        status: response.status,
        body: text,
      });
      throw new Error(`Device code request failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      device_auth_id: string;
      user_code: string;
      interval?: number;
    };

    return {
      userCode: data.user_code,
      deviceAuthId: data.device_auth_id,
      interval: typeof data.interval === "number" ? data.interval : 5,
    };
  }

  /**
   * Poll for token after user has authorized the device code.
   * Returns null if still pending, throws on permanent failure.
   */
  async pollForToken(
    deviceAuthId: string,
    userCode: string
  ): Promise<DeviceTokenResult | null> {
    const response = await fetch(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: DEVICE_HEADERS,
      body: JSON.stringify({
        device_auth_id: deviceAuthId,
        user_code: userCode,
      }),
    });

    // 403/404/429 = user hasn't authorized yet
    if (
      response.status === 403 ||
      response.status === 404 ||
      response.status === 429
    ) {
      return null;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      this.logger.error("Device token poll failed", {
        status: response.status,
        body: text,
      });
      throw new Error(`Device token poll failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      authorization_code?: string;
      code_verifier?: string;
    };

    if (!data.authorization_code || !data.code_verifier) {
      this.logger.warn(
        "Poll response missing authorization fields, still pending"
      );
      return null;
    }

    // Exchange authorization code for access token
    return this.exchangeCode(data.authorization_code, data.code_verifier);
  }

  /**
   * Exchange authorization code for access/refresh tokens.
   *
   * Form-encoded per RFC 6749 §4.1.3 via the shared {@link exchangeToken}
   * plumbing. The OpenAI `reqwest` User-Agent is preserved — `Content-Type`
   * is owned by the base client (form-urlencoded for `contentType: "form"`).
   */
  private async exchangeCode(
    authorizationCode: string,
    codeVerifier: string
  ): Promise<DeviceTokenResult> {
    const data = await this.exchangeToken<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
      id_token?: string;
    }>(
      TOKEN_EXCHANGE_URL,
      {
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: authorizationCode,
        code_verifier: codeVerifier,
        redirect_uri: DEVICE_REDIRECT_URI,
        scope: OAUTH_SCOPE,
      },
      "form",
      { "User-Agent": TOKEN_USER_AGENT }
    );

    if (!data.refresh_token) {
      throw new Error("Token response missing required fields");
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      accountId: this.extractAccountId(data.access_token),
    };
  }

  /**
   * Exchange a stored refresh token for a fresh access token.
   *
   * Same OAuth token endpoint and form-encoding as {@link exchangeCode} (RFC
   * 6749 §6), via the shared {@link refreshAccessToken} plumbing. Returns
   * {@link OAuthCredentials} so this client can be registered directly in the
   * gateway's `TokenRefreshJob` alongside the Claude `OAuthClient`. OpenAI does
   * not always rotate the refresh token, so the existing one is preserved when
   * the response omits it — otherwise the stored refresh token would be wiped on
   * every refresh. The `scope` parameter (which the generic
   * `refreshTokenWithConfig` does not carry) is part of OpenAI's required wire
   * shape, so the body is built explicitly here.
   */
  async refreshToken(refreshToken: string): Promise<OAuthCredentials> {
    const data = await this.refreshAccessToken<{
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    }>(
      TOKEN_EXCHANGE_URL,
      {
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
        scope: OAUTH_SCOPE,
      },
      "form",
      { "User-Agent": TOKEN_USER_AGENT }
    );

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      tokenType: "Bearer",
      expiresAt: this.calculateExpiresAt(data.expires_in ?? 0) ?? Date.now(),
      scopes: this.parseScopes(OAUTH_SCOPE),
    };
  }

  /**
   * Extract account ID from JWT access token (informational only).
   * Decodes the JWT payload without signature verification because the token
   * was obtained directly from OpenAI's token endpoint over HTTPS.
   * The extracted accountId is used only for logging/display, not for
   * authorization decisions.
   */
  extractAccountId(accessToken: string): string | undefined {
    try {
      const parts = accessToken.split(".");
      if (parts.length < 2) return undefined;

      const payload = JSON.parse(
        Buffer.from(parts[1]!, "base64url").toString("utf-8")
      );

      // OpenAI stores account info under the JWT_CLAIM_PATH
      const authClaim = payload[JWT_CLAIM_PATH];
      if (authClaim?.organization_id) {
        return authClaim.organization_id;
      }
      if (authClaim?.chatgpt_account_id) {
        return authClaim.chatgpt_account_id;
      }

      return undefined;
    } catch (error) {
      this.logger.warn("Failed to extract account ID from JWT", { error });
      return undefined;
    }
  }
}
