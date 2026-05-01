import { createLogger } from "@lobu/core";

const logger = createLogger("chatgpt-device-code");

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
const DEVICE_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "reqwest/0.12.24",
};
const TOKEN_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "reqwest/0.12.24",
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
 */
export class ChatGPTDeviceCodeClient {
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
      logger.error("Device code request failed", {
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
      logger.error("Device token poll failed", {
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
      logger.warn("Poll response missing authorization fields, still pending");
      return null;
    }

    // Exchange authorization code for access token
    return this.exchangeCode(data.authorization_code, data.code_verifier);
  }

  /**
   * Exchange authorization code for access/refresh tokens.
   */
  private async exchangeCode(
    authorizationCode: string,
    codeVerifier: string
  ): Promise<DeviceTokenResult> {
    const response = await fetch(TOKEN_EXCHANGE_URL, {
      method: "POST",
      headers: TOKEN_HEADERS,
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: authorizationCode,
        code_verifier: codeVerifier,
        redirect_uri: DEVICE_REDIRECT_URI,
        scope: OAUTH_SCOPE,
      }).toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      logger.error("Token exchange failed", {
        status: response.status,
        body: text,
      });
      throw new Error(`Token exchange failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      id_token?: string;
    };

    if (!data.access_token || !data.refresh_token) {
      throw new Error("Token response missing required fields");
    }

    const accountId = this.extractAccountId(data.access_token);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      accountId,
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
      logger.warn("Failed to extract account ID from JWT", { error });
      return undefined;
    }
  }
}
