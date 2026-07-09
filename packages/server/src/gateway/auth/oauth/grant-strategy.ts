/**
 * Interactive OAuth grant dispatch. Config is data-only; this module maps
 * `config.grant` → start/complete using the shared {@link OAuthClient}.
 */

import { OAuthClient } from "./client.js";
import type { OAuthProviderConfig } from "./providers.js";

export type OAuthScope =
  | { kind: "agent"; agentId: string; userId: string }
  | { kind: "org"; slug: string; organizationId: string; userId: string };

export type StartResult =
  | { mode: "redirect"; authorizeUrl: string }
  | {
      mode: "device";
      userCode: string;
      deviceAuthId: string;
      interval: number;
      verificationUrl: string;
    };

export interface StartContext {
  stateToken: string;
  codeVerifier: string;
}

export type CompleteInput =
  | {
      mode: "redirect";
      code: string;
      state: string;
      codeVerifier: string;
    }
  | { mode: "device"; deviceAuthId: string; userCode: string };

export interface StoredCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  authType: "oauth" | "device-code";
  accountId?: string;
}

export interface GrantStrategy {
  start(
    config: OAuthProviderConfig,
    scope: OAuthScope,
    ctx?: StartContext,
  ): Promise<StartResult>;
  complete(
    config: OAuthProviderConfig,
    scope: OAuthScope,
    input: CompleteInput,
  ): Promise<StoredCredential | null>;
}

const strategy: GrantStrategy = {
  async start(config, _scope, ctx) {
    const client = new OAuthClient(config);
    const grant = config.grant ?? "authorization-code";

    if (grant === "authorization-code") {
    if (!ctx) {
      throw new Error(
          "authorization-code start requires StartContext (state + verifier)",
      );
    }
      return {
        mode: "redirect",
        authorizeUrl: client.buildAuthUrl(ctx.stateToken, ctx.codeVerifier),
      };
  }

    // device-code (RFC) + openai-device-auth share the same UI shape.
    const device = await client.requestDeviceCode();
    return {
      mode: "device",
      userCode: device.userCode,
      deviceAuthId: device.deviceAuthId,
      interval: device.interval,
      verificationUrl: device.verificationUrl,
    };
  },

  async complete(config, _scope, input) {
    const client = new OAuthClient(config);
    const grant = config.grant ?? "authorization-code";
    const authType = config.authType ?? "oauth";

    if (grant === "authorization-code") {
    if (input.mode !== "redirect") {
        throw new Error("authorization-code complete requires redirect input");
    }
      // redirect_uri must match authorize URL (config.redirectUri); state is 4th arg.
    const credentials = await client.exchangeCodeForToken(
      input.code,
      input.codeVerifier,
      undefined,
        input.state,
    );
    return {
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
        authType,
    };
  }

    if (input.mode !== "device") {
      throw new Error("device grant complete requires device input");
    }
    const result = await client.pollForToken(
      input.deviceAuthId,
      input.userCode,
    );
    if (!result) return null;
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: Date.now() + result.expiresIn * 1000,
      authType: config.authType ?? "device-code",
      accountId: result.accountId,
    };
  },
};

/** One strategy object — grant kind is read from config at call time. */
export function grantStrategyFor(_config: OAuthProviderConfig): GrantStrategy {
  return strategy;
}
