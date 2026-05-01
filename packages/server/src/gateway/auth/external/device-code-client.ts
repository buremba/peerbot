import { BaseOAuth2Client } from "../oauth/base-client.js";
import type { OAuthCredentials } from "../oauth/credentials.js";

export const DEVICE_CODE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:device_code";

interface DeviceCodeClientConfig {
  clientId: string;
  clientSecret?: string;
  tokenUrl: string;
  deviceAuthorizationUrl: string;
  scope: string;
  /** RFC 8707 resource indicator included in token requests. */
  resource?: string;
  tokenEndpointAuthMethod?:
    | "none"
    | "client_secret_post"
    | "client_secret_basic";
}

export interface DeviceAuthorizationStartResult {
  deviceAuthId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  interval: number;
  expiresIn: number;
}

type DeviceAuthorizationPollResult =
  | {
      status: "pending";
      interval?: number;
    }
  | {
      status: "complete";
      credentials: OAuthCredentials;
    }
  | {
      status: "error";
      error: string;
      errorCode?: string;
    };

interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface DeviceTokenSuccessResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

interface DeviceTokenErrorResponse {
  error: string;
  error_description?: string;
}

export class GenericDeviceCodeClient extends BaseOAuth2Client {
  constructor(private readonly config: DeviceCodeClientConfig) {
    super("external-device-code-client");
  }

  async requestDeviceCode(): Promise<DeviceAuthorizationStartResult> {
    const params: Record<string, string> = {
      client_id: this.config.clientId,
      scope: this.config.scope,
    };
    if (this.config.resource) {
      params.resource = this.config.resource;
    }
    const { headers, body } = this.buildAuthenticatedFormBody(params);

    const response = await fetch(this.config.deviceAuthorizationUrl, {
      method: "POST",
      headers,
      body: body.toString(),
    });

    const data = await this.parseJsonResponse<
      DeviceAuthorizationResponse | DeviceTokenErrorResponse
    >(response);

    if (!response.ok || "error" in data) {
      throw new Error(
        this.formatOAuthError("Device authorization failed", data)
      );
    }

    return {
      deviceAuthId: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      verificationUriComplete: data.verification_uri_complete,
      interval: Math.max(data.interval ?? 5, 1),
      expiresIn: data.expires_in,
    };
  }

  async pollForToken(
    deviceAuthId: string,
    intervalSeconds?: number
  ): Promise<DeviceAuthorizationPollResult> {
    const params: Record<string, string> = {
      grant_type: DEVICE_CODE_GRANT_TYPE,
      device_code: deviceAuthId,
      client_id: this.config.clientId,
    };
    if (this.config.resource) {
      params.resource = this.config.resource;
    }
    const { headers, body } = this.buildAuthenticatedFormBody(params);

    const response = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers,
      body: body.toString(),
    });

    const data = await this.parseJsonResponse<
      DeviceTokenSuccessResponse | DeviceTokenErrorResponse
    >(response);

    if (!response.ok || "error" in data) {
      if ("error" in data) {
        if (data.error === "authorization_pending") {
          return { status: "pending", interval: intervalSeconds };
        }
        if (data.error === "slow_down") {
          return {
            status: "pending",
            interval: Math.max((intervalSeconds ?? 5) + 5, 1),
          };
        }
        if (data.error === "expired_token" || data.error === "access_denied") {
          return {
            status: "error",
            error: data.error_description || data.error,
            errorCode: data.error,
          };
        }
      }

      throw new Error(
        this.formatOAuthError("Device token polling failed", data)
      );
    }

    const credentials = this.buildCredentials(data);
    return {
      status: "complete",
      credentials,
    };
  }

  private buildCredentials(
    tokenData: DeviceTokenSuccessResponse
  ): OAuthCredentials {
    return {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      tokenType: tokenData.token_type || "Bearer",
      expiresAt:
        this.calculateExpiresAt(tokenData.expires_in) ?? Date.now() + 3_600_000,
      scopes: this.parseScopes(tokenData.scope),
    };
  }

  private buildAuthenticatedFormBody(params: Record<string, string>): {
    headers: Record<string, string>;
    body: URLSearchParams;
  } {
    const body = new URLSearchParams(params);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    };
    const authMethod = this.config.tokenEndpointAuthMethod || "none";

    if (authMethod === "client_secret_basic") {
      headers.Authorization = `Basic ${Buffer.from(
        `${this.config.clientId}:${this.config.clientSecret || ""}`
      ).toString("base64")}`;
    } else if (
      authMethod === "client_secret_post" &&
      this.config.clientSecret
    ) {
      body.set("client_secret", this.config.clientSecret);
    }

    return { headers, body };
  }

  private async parseJsonResponse<T>(response: Response): Promise<T> {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return (await response.json()) as T;
    }

    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      return { error: text || response.statusText } as T;
    }
  }

  private formatOAuthError(prefix: string, data: unknown): string {
    if (data && typeof data === "object" && "error" in data) {
      const record = data as {
        error?: unknown;
        error_description?: unknown;
      };
      const error =
        typeof record.error === "string" ? record.error : "unknown_error";
      const description =
        typeof record.error_description === "string"
          ? record.error_description
          : undefined;
      return description
        ? `${prefix}: ${error} - ${description}`
        : `${prefix}: ${error}`;
    }

    return prefix;
  }
}
