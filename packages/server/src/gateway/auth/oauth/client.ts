/**
 * Single config-driven OAuth client for every subscription provider.
 *
 * Handles authorization-code (Claude), RFC 8628 device-code (xAI), and OpenAI's
 * proprietary JSON device-auth (ChatGPT). Behavior is selected by
 * `config.grant` — no per-provider subclasses.
 */

import { BaseOAuth2Client } from "./base-client.js";
import type { OAuthCredentials } from "./credentials.js";
import {
  listOAuthProviders,
  type OAuthProviderConfig,
  resolveOAuthScope,
} from "./providers.js";

const RFC_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * Build the browser verification URL for a device-code start.
 *
 * Priority:
 * 1. RFC `verification_uri_complete` (provider-supplied prefill URL) as-is
 * 2. Base `verification_uri` / `defaultVerificationUrl`
 * 3. Optionally append `verificationUserCodeParam=userCode` when the provider
 *    config opts into prefill (e.g. xAI `"user_code"`). Omitted for providers
 *    whose pages do not document query prefill (ChatGPT Codex).
 */
export function resolveDeviceVerificationUrl(options: {
  verificationUriComplete?: string | null;
  verificationUri?: string | null;
  defaultVerificationUrl?: string | null;
  /** Query param name to prefill, from provider config. Empty/omit = no prefill. */
  verificationUserCodeParam?: string | null;
  userCode: string;
}): string {
  const complete = options.verificationUriComplete?.trim();
  if (complete) return complete;

  const base =
    options.verificationUri?.trim() ||
    options.defaultVerificationUrl?.trim() ||
    "";
  if (!base) {
    throw new Error(
      "Device code response missing verification_uri and no defaultVerificationUrl",
    );
  }
  const param = options.verificationUserCodeParam?.trim();
  if (!param) return base;
  return withUserCodeQuery(base, options.userCode, param);
}

/** Append a user-code query param when the URL does not already carry it. */
export function withUserCodeQuery(
  url: string,
  userCode: string,
  paramName = "user_code",
): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has(paramName)) return parsed.toString();
    parsed.searchParams.set(paramName, userCode);
    return parsed.toString();
  } catch {
    // Non-absolute URLs are rare for device verification; still be safe.
    const re = new RegExp(`[?&]${paramName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=`);
    if (re.test(url)) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}${encodeURIComponent(paramName)}=${encodeURIComponent(userCode)}`;
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

export interface DeviceCodeStart {
  userCode: string;
  /** RFC `device_code` or OpenAI `device_auth_id` — both travel as deviceAuthId on the wire. */
  deviceAuthId: string;
  interval: number;
  verificationUrl: string;
}

export interface DeviceTokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  accountId?: string;
}

export class OAuthClient extends BaseOAuth2Client {
  constructor(readonly config: OAuthProviderConfig) {
    super(`${config.id}-oauth`);
  }

  // ── shared helpers ──────────────────────────────────────────────────────

  private scope(): string {
    return resolveOAuthScope(this.config);
  }

  private headers(contentType?: "json" | "form"): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(this.config.customHeaders ?? {}),
    };
    if (contentType === "json") {
      headers["Content-Type"] = "application/json";
    } else if (contentType === "form") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    if (this.config.userAgent) {
      headers["User-Agent"] = this.config.userAgent;
    }
    return headers;
  }

  private tokenFormat(): "json" | "form" {
    return this.config.tokenRequestFormat ?? "json";
  }

  private buildCredentials(
    tokenData: TokenResponse,
    fallbackRefreshToken?: string,
  ): OAuthCredentials {
    const refreshToken = tokenData.refresh_token ?? fallbackRefreshToken;
    if (!refreshToken && this.config.requireRefreshToken !== false) {
      throw new Error(
        `${this.config.name} OAuth response missing refresh token`,
      );
    }
    return {
      accessToken: tokenData.access_token,
      refreshToken,
      tokenType: tokenData.token_type || "Bearer",
      expiresAt:
        this.calculateExpiresAt(tokenData.expires_in ?? 3600) ?? Date.now(),
      scopes: this.parseScopes(tokenData.scope ?? this.scope()),
    };
  }

  private require(
    field: "deviceCodeUrl" | "deviceTokenUrl" | "authUrl" | "redirectUri",
  ): string {
    const value =
      field === "redirectUri"
        ? (this.config.deviceRedirectUri ?? this.config.redirectUri)?.trim()
        : this.config[field]?.trim();
    if (!value) {
      throw new Error(`${this.config.name} OAuth config is missing ${field}`);
    }
    return value;
  }

  // ── refresh (all grants) ────────────────────────────────────────────────

  async refreshToken(refreshToken: string): Promise<OAuthCredentials> {
    const body: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.config.clientId,
    };
    if (
      this.config.clientSecret &&
      this.config.tokenEndpointAuthMethod !== "none"
    ) {
      body.client_secret = this.config.clientSecret;
    }
    if (this.config.includeScopeInRefresh) {
      body.scope = this.scope();
    }

    const tokenData = await this.refreshAccessToken<TokenResponse>(
      this.config.tokenUrl,
      body,
      this.tokenFormat(),
      this.headers(),
    );
    return this.buildCredentials(tokenData, refreshToken);
  }

  // ── authorization-code ──────────────────────────────────────────────────

  buildAuthUrl(
    state: string,
    codeVerifier: string,
    customRedirectUri?: string,
  ): string {
    const authUrl = this.require("authUrl");
    const redirectUri = customRedirectUri || this.require("redirectUri");
    const url = new URL(authUrl);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", this.config.responseType || "code");
    url.searchParams.set("state", state);
    url.searchParams.set("scope", this.scope());
    url.searchParams.set(
      "code_challenge",
      this.generateCodeChallenge(codeVerifier),
    );
    url.searchParams.set("code_challenge_method", "S256");
    for (const [k, v] of Object.entries(this.config.extraAuthParams ?? {})) {
      url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async exchangeCodeForToken(
    code: string,
    codeVerifier: string,
    customRedirectUri?: string,
    state?: string,
  ): Promise<OAuthCredentials> {
    const body: Record<string, string | number> = {
      grant_type: this.config.grantType || "authorization_code",
      client_id: this.config.clientId,
      code,
      // Prefer explicit override (external-auth alternate host); never swap
      // this parameter with `state` — ExternalAuthClient passes redirectUri
      // as the 3rd arg and state is not used on that path.
      redirect_uri: customRedirectUri || this.require("redirectUri"),
      code_verifier: codeVerifier,
      ...(this.config.extraTokenParams ?? {}),
    };
    if (state) body.state = state;

    const tokenData = await this.exchangeToken<TokenResponse>(
      this.config.tokenUrl,
      body,
      this.tokenFormat(),
      this.headers(),
    );
    return this.buildCredentials(tokenData);
  }

  // ── device grants (RFC + OpenAI) ────────────────────────────────────────

  async requestDeviceCode(): Promise<DeviceCodeStart> {
    const grant = this.config.grant ?? "authorization-code";
    if (grant === "openai-device-auth") {
      return this.requestOpenAIDeviceCode();
    }
    if (grant === "device-code") {
      return this.requestRfcDeviceCode();
    }
    throw new Error(
      `${this.config.name} does not support device-code login (grant=${grant})`,
    );
  }

  /**
   * Poll until authorized. Returns null while pending.
   * `userCode` is required for OpenAI; ignored for RFC.
   */
  async pollForToken(
    deviceAuthId: string,
    userCode?: string,
  ): Promise<DeviceTokenResult | null> {
    const grant = this.config.grant ?? "authorization-code";
    if (grant === "openai-device-auth") {
      if (!userCode) {
        throw new Error("OpenAI device-auth poll requires userCode");
      }
      return this.pollOpenAIDeviceToken(deviceAuthId, userCode);
    }
    if (grant === "device-code") {
      return this.pollRfcDeviceToken(deviceAuthId);
    }
    throw new Error(
      `${this.config.name} does not support device-code poll (grant=${grant})`,
    );
  }

  private async requestRfcDeviceCode(): Promise<DeviceCodeStart> {
    const response = await fetch(this.require("deviceCodeUrl"), {
      method: "POST",
      headers: this.headers("form"),
      body: new URLSearchParams({
        client_id: this.config.clientId,
        scope: this.scope(),
      }).toString(),
    });
    const data = await this.readJson(response, "Device code request");
    if (
      typeof data.device_code !== "string" ||
      !data.device_code ||
      typeof data.user_code !== "string" ||
      !data.user_code
    ) {
      throw new Error("Device code response missing device_code or user_code");
    }
    const verificationUrl = resolveDeviceVerificationUrl({
      verificationUriComplete:
        typeof data.verification_uri_complete === "string"
          ? data.verification_uri_complete
          : undefined,
      verificationUri:
        typeof data.verification_uri === "string"
          ? data.verification_uri
          : undefined,
      defaultVerificationUrl: this.config.defaultVerificationUrl,
      verificationUserCodeParam: this.config.verificationUserCodeParam,
      userCode: data.user_code,
    });
    return {
      deviceAuthId: data.device_code,
      userCode: data.user_code,
      verificationUrl,
      interval: typeof data.interval === "number" ? data.interval : 5,
    };
  }

  private async pollRfcDeviceToken(
    deviceCode: string,
  ): Promise<DeviceTokenResult | null> {
    const response = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: this.headers("form"),
      body: new URLSearchParams({
        grant_type: RFC_DEVICE_GRANT,
        device_code: deviceCode,
        client_id: this.config.clientId,
      }).toString(),
    });
    const text = await response.text().catch(() => "");
    let data: Record<string, unknown> = {};
    if (text) {
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        /* non-JSON */
      }
    }
    const err = typeof data.error === "string" ? data.error : undefined;
    // Both pending states return null so the UI re-polls. RFC 8628 suggests
    // increasing the interval on slow_down; the client already exposes
    // `interval` from the device-code response and the UI drives the pace.
    if (err === "authorization_pending" || err === "slow_down") return null;
    if (!response.ok) {
      throw new Error(
        `Device token poll failed: ${response.status}${err ? ` ${err}` : ""}`,
      );
    }
    if (err) {
      throw new Error(`Device token poll failed: ${err}`);
    }
    if (typeof data.access_token !== "string" || !data.access_token) {
      return null;
    }
    const creds = this.buildCredentials({
      access_token: data.access_token,
      refresh_token:
        typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      expires_in: typeof data.expires_in === "number" ? data.expires_in : 3600,
    });
    return {
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresIn: typeof data.expires_in === "number" ? data.expires_in : 3600,
    };
  }

  private async requestOpenAIDeviceCode(): Promise<DeviceCodeStart> {
    const response = await fetch(this.require("deviceCodeUrl"), {
      method: "POST",
      headers: this.headers("json"),
      body: JSON.stringify({
        client_id: this.config.clientId,
        scope: this.scope(),
      }),
    });
    if (!response.ok) {
      throw new Error(`Device code request failed: ${response.status}`);
    }
    const data = (await response.json()) as {
      device_auth_id: string;
      user_code: string;
      interval?: number;
    };
    if (!this.config.defaultVerificationUrl?.trim()) {
      throw new Error(
        `${this.config.name} openai-device-auth config requires defaultVerificationUrl`,
      );
    }
    // OpenAI does not return verification_uri*; use configured base, and only
    // append a code query param when this provider opts into prefill.
    const verificationUrl = resolveDeviceVerificationUrl({
      defaultVerificationUrl: this.config.defaultVerificationUrl,
      verificationUserCodeParam: this.config.verificationUserCodeParam,
      userCode: data.user_code,
    });
    return {
      deviceAuthId: data.device_auth_id,
      userCode: data.user_code,
      interval: typeof data.interval === "number" ? data.interval : 5,
      verificationUrl,
    };
  }

  private async pollOpenAIDeviceToken(
    deviceAuthId: string,
    userCode: string,
  ): Promise<DeviceTokenResult | null> {
    const response = await fetch(this.require("deviceTokenUrl"), {
      method: "POST",
      headers: this.headers("json"),
      body: JSON.stringify({
        device_auth_id: deviceAuthId,
        user_code: userCode,
      }),
    });
    const pending = this.config.pendingStatusCodes ?? [403, 404, 429];
    if (pending.includes(response.status)) return null;
    if (!response.ok) {
      throw new Error(`Device token poll failed: ${response.status}`);
    }
    const data = (await response.json()) as {
      authorization_code?: string;
      code_verifier?: string;
    };
    if (!data.authorization_code || !data.code_verifier) return null;

    const tokenData = await this.exchangeToken<TokenResponse>(
      this.config.tokenUrl,
      {
        grant_type: "authorization_code",
        client_id: this.config.clientId,
        code: data.authorization_code,
        code_verifier: data.code_verifier,
        redirect_uri: this.require("redirectUri"),
        scope: this.scope(),
      },
      this.tokenFormat(),
      this.headers(),
    );
    const creds = this.buildCredentials(tokenData);
    return {
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      // Match buildCredentials default so grant-strategy never stores expiresAt=now.
      expiresIn: tokenData.expires_in ?? 3600,
      accountId: this.extractAccountId(creds.accessToken),
    };
  }

  /** JWT account id (ChatGPT display only). */
  extractAccountId(accessToken: string): string | undefined {
    return extractJwtAccountId(
      accessToken,
      this.config.accountIdClaimPath ?? "https://api.openai.com/auth",
    );
  }

  private async readJson(
    response: Response,
    label: string,
  ): Promise<Record<string, unknown>> {
    const text = await response.text().catch(() => "");
    let data: Record<string, unknown> = {};
    if (text) {
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        /* non-JSON */
      }
    }
    if (!response.ok || typeof data.error === "string") {
      const err = typeof data.error === "string" ? data.error : undefined;
      const desc =
        typeof data.error_description === "string"
          ? data.error_description
          : undefined;
      throw new Error(
        `${label} failed: ${response.status}${err ? ` ${err}` : ""}${desc ? ` — ${desc}` : ""}${!err && text ? ` ${text}` : ""}`,
      );
    }
    return data;
  }

  getConfig(): OAuthProviderConfig {
    return { ...this.config };
  }
}

/**
 * Decode an informational account id from a JWT access token without verifying
 * the signature (token was obtained over HTTPS from the IdP). Used by ChatGPT
 * credential placeholders even when the OAuth registry has no chatgpt entry.
 */
export function extractJwtAccountId(
  accessToken: string,
  claimPath = "https://api.openai.com/auth",
): string | undefined {
  try {
    const parts = accessToken.split(".");
    const payloadB64 = parts[1];
    if (!payloadB64) return undefined;
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf-8"),
    ) as Record<string, { organization_id?: string; chatgpt_account_id?: string }>;
    const authClaim = payload[claimPath];
    return (
      authClaim?.organization_id ?? authClaim?.chatgpt_account_id ?? undefined
    );
  } catch {
    return undefined;
  }
}

/** Token-refresh entries for every loaded OAuth provider (from config). */
export function buildOAuthRefreshers(
  providers: readonly OAuthProviderConfig[] = listOAuthProviders(),
): Array<{ providerId: string; refresher: OAuthClient }> {
  return providers.map((config) => ({
    providerId: config.id,
    refresher: new OAuthClient(config),
  }));
}
