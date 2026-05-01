import { randomBytes } from "node:crypto";
import { createLogger } from "@lobu/core";
import { OAuthClient } from "../oauth/client.js";
import type { OAuthCredentials } from "../oauth/credentials.js";
import type { OAuthProviderConfig } from "../oauth/providers.js";
import {
  DEVICE_CODE_GRANT_TYPE,
  type DeviceAuthorizationStartResult,
  GenericDeviceCodeClient,
} from "./device-code-client.js";

const logger = createLogger("external-auth-client");
const EXTERNAL_AUTH_CACHE_KEY = "external:auth:client:v3";
const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SCOPE = "profile:read";

export interface ExternalAuthConfig {
  issuerUrl: string;
  clientId?: string;
  clientSecret?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  deviceAuthorizationUrl?: string;
  redirectUri: string;
  /** Additional redirect URIs to register (e.g. PUBLIC_GATEWAY_URL alongside localhost) */
  additionalRedirectUris?: string[];
  scope?: string;
  cacheStore?: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string, ttlSeconds: number) => Promise<void>;
  };
}

interface WellKnownMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  userinfo_endpoint?: string;
  device_authorization_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
  grant_types_supported?: string[];
}

interface UserInfoResponse {
  sub: string;
  email: string;
  name?: string;
}

interface DynamicClientCredentials {
  client_id: string;
  client_secret?: string;
  token_endpoint_auth_method?:
    | "none"
    | "client_secret_post"
    | "client_secret_basic";
  client_secret_expires_at?: number;
  grant_types?: string[];
}

interface ResolvedExternalAuthConfig {
  clientId: string;
  clientSecret?: string;
  authUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  deviceAuthorizationUrl?: string;
  grantTypesSupported: string[];
  tokenEndpointAuthMethod:
    | "none"
    | "client_secret_post"
    | "client_secret_basic";
}

interface ExternalAuthCapabilities {
  browser: boolean;
  device: boolean;
}

type ExternalDeviceAuthorizationPollResult =
  | {
      status: "pending";
      interval?: number;
    }
  | {
      status: "error";
      error: string;
      errorCode?: string;
    }
  | {
      status: "complete";
      credentials: OAuthCredentials;
      user?: UserInfoResponse;
    };

export class ExternalAuthClient {
  private discoveryCache: {
    metadata: WellKnownMetadata | null;
    resolvedAt: number;
  } | null = null;

  constructor(private readonly config: ExternalAuthConfig) {}

  generateCodeVerifier(): string {
    return randomBytes(32).toString("base64url");
  }

  async buildAuthUrl(
    state: string,
    codeVerifier: string,
    redirectUri?: string
  ): Promise<string> {
    const resolved = await this.resolveConfig();
    if (!resolved.authUrl || !resolved.tokenUrl) {
      throw new Error(
        "External auth: authorization and token URLs are required for browser login"
      );
    }

    return this.buildOAuthClient(resolved).buildAuthUrl(
      state,
      codeVerifier,
      redirectUri
    );
  }

  async exchangeCodeForToken(
    code: string,
    codeVerifier: string,
    redirectUri?: string
  ): Promise<OAuthCredentials> {
    const resolved = await this.resolveConfig();
    if (!resolved.authUrl || !resolved.tokenUrl) {
      throw new Error(
        "External auth: authorization and token URLs are required for browser login"
      );
    }

    return this.buildOAuthClient(resolved).exchangeCodeForToken(
      code,
      codeVerifier,
      redirectUri
    );
  }

  async fetchUserInfo(accessToken: string): Promise<UserInfoResponse> {
    const resolved = await this.resolveConfig();
    if (!resolved.userinfoUrl) {
      throw new Error(
        "External auth: userinfo endpoint not available (expose it via OIDC discovery)"
      );
    }

    const response = await fetch(resolved.userinfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to fetch user info: ${response.status} ${errorText}`
      );
    }

    const data = (await response.json()) as UserInfoResponse;
    logger.info("Fetched external auth user info", {
      sub: data.sub,
      email: data.email,
    });
    return data;
  }

  async getCapabilities(): Promise<ExternalAuthCapabilities> {
    const resolved = await this.resolveConfig();
    return {
      browser: !!(resolved.authUrl && resolved.tokenUrl),
      device: !!(resolved.deviceAuthorizationUrl && resolved.tokenUrl),
    };
  }

  async startDeviceAuthorization(): Promise<DeviceAuthorizationStartResult> {
    const resolved = await this.resolveConfig();
    if (!resolved.deviceAuthorizationUrl || !resolved.tokenUrl) {
      throw new Error("External auth: device authorization is not supported");
    }

    try {
      return await this.buildDeviceCodeClient(resolved).requestDeviceCode();
    } catch (error) {
      if (
        this.config.clientId &&
        error instanceof Error &&
        error.message.includes("invalid_client")
      ) {
        logger.warn(
          "Static external auth client was rejected for device flow, retrying with dynamic registration"
        );
        const dynamicResolved = await this.resolveConfig({
          forceDynamicClient: true,
        });
        return this.buildDeviceCodeClient(dynamicResolved).requestDeviceCode();
      }

      throw error;
    }
  }

  async pollDeviceAuthorization(
    deviceAuthId: string,
    intervalSeconds?: number
  ): Promise<ExternalDeviceAuthorizationPollResult> {
    const resolved = await this.resolveConfig();
    if (!resolved.deviceAuthorizationUrl || !resolved.tokenUrl) {
      throw new Error("External auth: device authorization is not supported");
    }

    const result = await this.buildDeviceCodeClient(resolved).pollForToken(
      deviceAuthId,
      intervalSeconds
    );
    if (result.status !== "complete") {
      return result;
    }

    const user = resolved.userinfoUrl
      ? await this.fetchUserInfo(result.credentials.accessToken)
      : undefined;

    return {
      ...result,
      user,
    };
  }

  static isConfigured(config?: { issuerUrl?: string | null }): boolean {
    return !!config?.issuerUrl?.trim();
  }

  static fromConfig(config: {
    issuerUrl?: string | null;
    publicGatewayUrl: string;
    cacheStore?: ExternalAuthConfig["cacheStore"];
  }): ExternalAuthClient | null {
    const issuerUrl = config.issuerUrl?.trim().replace(/\/+$/, "");
    if (!issuerUrl) return null;

    const callbackPath = "/connect/oauth/callback";

    // Register redirect URIs for both the configured public URL and localhost
    // so OAuth works regardless of how the user accesses the gateway.
    const redirectUri = `${config.publicGatewayUrl}${callbackPath}`;
    const additionalRedirectUris = [
      `http://localhost:8080${callbackPath}`,
    ].filter((uri) => uri !== redirectUri);

    return new ExternalAuthClient({
      issuerUrl,
      redirectUri,
      additionalRedirectUris,
      scope: DEFAULT_SCOPE,
      cacheStore: config.cacheStore,
    });
  }

  private async resolveConfig(options?: {
    forceDynamicClient?: boolean;
  }): Promise<ResolvedExternalAuthConfig> {
    const metadata = await this.discoverMetadata();
    const dynamicCredentials = await this.getDynamicClientCredentials(
      metadata,
      {
        forceRegistration: options?.forceDynamicClient,
      }
    );

    const clientId = dynamicCredentials?.client_id || this.config.clientId;
    const clientSecret =
      dynamicCredentials?.client_secret || this.config.clientSecret;

    if (!clientId) {
      throw new Error(
        "External auth: client registration failed and no static client ID is configured"
      );
    }

    const authMethods = metadata?.token_endpoint_auth_methods_supported;
    const tokenEndpointAuthMethod =
      dynamicCredentials?.token_endpoint_auth_method ||
      this.selectTokenEndpointAuthMethod(authMethods, clientSecret);

    return {
      clientId,
      clientSecret,
      authUrl: this.config.authorizeUrl || metadata?.authorization_endpoint,
      tokenUrl: this.config.tokenUrl || metadata?.token_endpoint,
      userinfoUrl: this.config.userinfoUrl || metadata?.userinfo_endpoint,
      deviceAuthorizationUrl:
        this.config.deviceAuthorizationUrl ||
        metadata?.device_authorization_endpoint,
      grantTypesSupported: metadata?.grant_types_supported || [],
      tokenEndpointAuthMethod,
    };
  }

  private buildOAuthClient(resolved: ResolvedExternalAuthConfig): OAuthClient {
    const providerConfig: OAuthProviderConfig = {
      id: "external-auth",
      name: "External Auth",
      clientId: resolved.clientId,
      clientSecret: resolved.clientSecret,
      authUrl: resolved.authUrl!,
      tokenUrl: resolved.tokenUrl!,
      redirectUri: this.config.redirectUri,
      scope: this.config.scope || DEFAULT_SCOPE,
      usePKCE: true,
      responseType: "code",
      grantType: "authorization_code",
      tokenEndpointAuthMethod: resolved.tokenEndpointAuthMethod,
      requireRefreshToken: false,
    };

    return new OAuthClient(providerConfig);
  }

  private buildDeviceCodeClient(
    resolved: ResolvedExternalAuthConfig
  ): GenericDeviceCodeClient {
    return new GenericDeviceCodeClient({
      clientId: resolved.clientId,
      clientSecret: resolved.clientSecret,
      tokenUrl: resolved.tokenUrl!,
      deviceAuthorizationUrl: resolved.deviceAuthorizationUrl!,
      scope: this.config.scope || DEFAULT_SCOPE,
      tokenEndpointAuthMethod: resolved.tokenEndpointAuthMethod,
    });
  }

  private async discoverMetadata(): Promise<WellKnownMetadata | null> {
    if (
      this.discoveryCache &&
      Date.now() - this.discoveryCache.resolvedAt < DISCOVERY_CACHE_TTL_MS
    ) {
      return this.discoveryCache.metadata;
    }

    const discoveryUrls = this.getDiscoveryUrls();

    for (const wellKnownUrl of discoveryUrls) {
      try {
        logger.info(`Discovering external auth endpoints from ${wellKnownUrl}`);
        const response = await fetch(wellKnownUrl);
        if (!response.ok) {
          logger.warn(
            `Failed to fetch external auth metadata from ${wellKnownUrl}: ${response.status}`
          );
          continue;
        }

        const metadata = (await response.json()) as WellKnownMetadata;
        logger.info("Discovered external auth endpoints", {
          discoveryUrl: wellKnownUrl,
          authUrl: this.config.authorizeUrl || metadata.authorization_endpoint,
          tokenUrl: this.config.tokenUrl || metadata.token_endpoint,
          userinfoUrl:
            this.config.userinfoUrl || metadata.userinfo_endpoint || null,
          deviceAuthorizationUrl:
            this.config.deviceAuthorizationUrl ||
            metadata.device_authorization_endpoint ||
            null,
          registrationEndpoint: metadata.registration_endpoint || null,
        });
        this.discoveryCache = { metadata, resolvedAt: Date.now() };
        return metadata;
      } catch (error) {
        logger.warn("Failed to discover external auth endpoints", {
          discoveryUrl: wellKnownUrl,
          error,
        });
      }
    }

    this.discoveryCache = { metadata: null, resolvedAt: Date.now() };
    return null;
  }

  private getDiscoveryUrls(): string[] {
    const trimmedIssuerUrl = this.config.issuerUrl.replace(/\/+$/, "");
    const candidates = [`${trimmedIssuerUrl}/.well-known/openid-configuration`];

    try {
      const origin = new URL(trimmedIssuerUrl).origin;
      const rootDiscoveryUrl = `${origin}/.well-known/openid-configuration`;
      if (!candidates.includes(rootDiscoveryUrl)) {
        candidates.push(rootDiscoveryUrl);
      }
    } catch {
      // Ignore invalid issuer URLs here; fetch will surface the real error.
    }

    return candidates;
  }

  private async getDynamicClientCredentials(
    metadata: WellKnownMetadata | null,
    options?: { forceRegistration?: boolean }
  ): Promise<DynamicClientCredentials | null> {
    if (!options?.forceRegistration) {
      const cached = await this.getCachedClientCredentials();
      if (cached) {
        return cached;
      }
    }

    if (!metadata?.registration_endpoint) {
      return null;
    }

    if (!options?.forceRegistration && this.config.clientId) {
      return null;
    }

    try {
      const requestedAuthMethod = this.selectTokenEndpointAuthMethod(
        metadata.token_endpoint_auth_methods_supported,
        undefined
      );
      const supportsDeviceGrant =
        !!metadata.device_authorization_endpoint ||
        metadata.grant_types_supported?.includes(DEVICE_CODE_GRANT_TYPE);

      logger.info("Registering external auth client dynamically", {
        registrationEndpoint: metadata.registration_endpoint,
        requestedAuthMethod,
        supportsDeviceGrant,
      });

      const response = await fetch(metadata.registration_endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_name: "Lobu CLI and Settings",
          redirect_uris: [
            this.config.redirectUri,
            ...(this.config.additionalRedirectUris || []),
          ].filter((v, i, a) => a.indexOf(v) === i),
          grant_types: supportsDeviceGrant
            ? ["authorization_code", "refresh_token", DEVICE_CODE_GRANT_TYPE]
            : ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: requestedAuthMethod,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.warn("External auth client registration failed", {
          status: response.status,
          errorText,
        });
        return null;
      }

      const credentials = (await response.json()) as DynamicClientCredentials;
      await this.cacheClientCredentials(credentials);
      logger.info("External auth client registered", {
        clientId: credentials.client_id,
        tokenEndpointAuthMethod:
          credentials.token_endpoint_auth_method || requestedAuthMethod,
      });
      return credentials;
    } catch (error) {
      logger.warn("External auth client registration failed", { error });
      return null;
    }
  }

  private async getCachedClientCredentials(): Promise<DynamicClientCredentials | null> {
    if (!this.config.cacheStore) {
      return null;
    }

    try {
      const raw = await this.config.cacheStore.get(EXTERNAL_AUTH_CACHE_KEY);
      if (!raw) {
        return null;
      }
      return JSON.parse(raw) as DynamicClientCredentials;
    } catch (error) {
      logger.warn("Failed to load cached external auth client", { error });
      return null;
    }
  }

  private async cacheClientCredentials(
    credentials: DynamicClientCredentials
  ): Promise<void> {
    if (!this.config.cacheStore) {
      return;
    }

    const ttlSeconds =
      credentials.client_secret_expires_at &&
      credentials.client_secret_expires_at > 0
        ? Math.max(
            60,
            Math.floor(credentials.client_secret_expires_at - Date.now() / 1000)
          )
        : 7 * 24 * 60 * 60;

    try {
      await this.config.cacheStore.set(
        EXTERNAL_AUTH_CACHE_KEY,
        JSON.stringify(credentials),
        ttlSeconds
      );
    } catch (error) {
      logger.warn("Failed to cache external auth client", { error });
    }
  }

  private selectTokenEndpointAuthMethod(
    supportedMethods: string[] | undefined,
    clientSecret?: string
  ): "none" | "client_secret_post" | "client_secret_basic" {
    const methods = new Set(supportedMethods || []);

    if (!clientSecret) {
      if (methods.size === 0 || methods.has("none")) {
        return "none";
      }
      if (methods.has("client_secret_post")) {
        return "client_secret_post";
      }
      if (methods.has("client_secret_basic")) {
        return "client_secret_basic";
      }
      return "none";
    }

    if (methods.has("client_secret_post")) {
      return "client_secret_post";
    }
    if (methods.has("client_secret_basic")) {
      return "client_secret_basic";
    }
    if (methods.has("none")) {
      return "none";
    }

    return "client_secret_post";
  }
}
