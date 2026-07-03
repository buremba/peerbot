/**
 * OAuth grant strategy — the thin seam between the generic OAuth routes and the
 * two concrete subclasses (`OAuthClient`, `ChatGPTDeviceCodeClient`).
 *
 * Config rows (`OAuthProviderConfig`) are DATA ONLY — they carry no functions.
 * The behavior that runs a flow lives here, behind a 3-method interface with two
 * adapters. Dispatch is by the `config.grant` discriminator alone
 * (`authorization-code` → {@link AuthorizationCodeGrant}, `device-code` →
 * {@link DeviceCodeGrant}); there is no dispatch table hidden in config.
 *
 * The adapters WRAP the existing subclasses — they do not reimplement the token
 * exchange, PKCE, or device handshake. `refreshToken` is already on both
 * subclasses (both satisfy `TokenRefresher`), so the strategy does not re-expose
 * it; the refresh job talks to the subclasses directly.
 */

import { OAuthClient } from "./client.js";
import type { OAuthProviderConfig } from "./providers.js";
import { ChatGPTDeviceCodeClient } from "../chatgpt/device-code-client.js";

/**
 * Where the resulting profile is stored. `agent` = a per-agent bucket
 * (`(userId, agentId)`); `org` = the per-user org bucket
 * (`(userId, "__org_oauth__:<slug>")`, with `organizationId` set on the row).
 * The route owns persistence; the strategy only produces the credential.
 */
export type OAuthScope =
  | { kind: "agent"; agentId: string; userId: string }
  | { kind: "org"; slug: string; organizationId: string; userId: string };

/**
 * Result of `start`. Authorization-code returns a `redirect` (send the user to
 * `authorizeUrl`; they paste back `code#state`). Device-code returns a `device`
 * (show `userCode`, poll). The route owns the OAuth state store: it mints the
 * state token + stores the `codeVerifier` BEFORE calling `start`, then passes
 * both into `StartContext` so the authorize URL embeds the canonical state.
 */
export type StartResult =
  | { mode: "redirect"; authorizeUrl: string }
  | {
      mode: "device";
      userCode: string;
      deviceAuthId: string;
      interval: number;
      verificationUrl: string;
    };

/**
 * State the ROUTE minted (via the OAuth state store) for an authorization-code
 * flow, threaded into `start` so the authorize URL carries the same `state` the
 * store will validate on `complete`. Ignored by the device-code grant.
 */
export interface StartContext {
  stateToken: string;
  codeVerifier: string;
}

/** Input to `complete`, discriminated by the same grant kind as `start`. */
export type CompleteInput =
  | {
      mode: "redirect";
      /** The authorization code the user pasted (the part before `#`). */
      code: string;
      /** The state echoed back (the part after `#`). */
      state: string;
      /** The PKCE verifier the route stashed in `start`. */
      codeVerifier: string;
    }
  | { mode: "device"; deviceAuthId: string; userCode: string };

/** The credential a completed grant yields, ready for `upsertProfile`. */
export interface StoredCredential {
  accessToken: string;
  refreshToken?: string;
  /** Unix ms. */
  expiresAt: number;
  /** The EXACT persisted auth-type string (`"oauth"` | `"device-code"`). */
  authType: "oauth" | "device-code";
  /** Optional display hint (ChatGPT account id). */
  accountId?: string;
}

/**
 * A grant strategy runs one interactive OAuth flow for a provider. `start`
 * begins it; `complete` finishes it. `complete` returns `null` ONLY for the
 * device-code grant while the user hasn't authorized yet (poll pending).
 */
export interface GrantStrategy {
  start(
    config: OAuthProviderConfig,
    scope: OAuthScope,
    ctx?: StartContext
  ): Promise<StartResult>;
  complete(
    config: OAuthProviderConfig,
    scope: OAuthScope,
    input: CompleteInput
  ): Promise<StoredCredential | null>;
}

/**
 * Authorization-code (Claude): redirect + paste `code#state`. Wraps the existing
 * `OAuthClient` — `buildAuthUrl` for `start`, `exchangeCodeForToken` for
 * `complete`. The route persists `codeVerifier` keyed by `stateToken`; the
 * `state` the user pastes back is re-supplied to `complete`.
 */
export class AuthorizationCodeGrant implements GrantStrategy {
  async start(
    config: OAuthProviderConfig,
    _scope: OAuthScope,
    ctx?: StartContext
  ): Promise<StartResult> {
    if (!ctx) {
      throw new Error(
        "AuthorizationCodeGrant.start requires a StartContext (state + verifier minted by the route)"
      );
    }
    const client = new OAuthClient(config);
    // The route already stored `codeVerifier` under `stateToken` in the OAuth
    // state store; the authorize URL must carry that same state so `complete`
    // can validate + retrieve the verifier. The strategy holds no state itself.
    const authorizeUrl = client.buildAuthUrl(ctx.stateToken, ctx.codeVerifier);
    return { mode: "redirect", authorizeUrl };
  }

  async complete(
    config: OAuthProviderConfig,
    _scope: OAuthScope,
    input: CompleteInput
  ): Promise<StoredCredential> {
    if (input.mode !== "redirect") {
      throw new Error(
        "AuthorizationCodeGrant.complete requires a redirect-mode input"
      );
    }
    const client = new OAuthClient(config);
    // No customRedirectUri: the exchange MUST reuse config.redirectUri (the
    // exact value buildAuthUrl sent). Overriding it reproduces lobu #1319
    // (`invalid_grant: Invalid 'redirect_uri'`).
    const credentials = await client.exchangeCodeForToken(
      input.code,
      input.codeVerifier,
      undefined,
      input.state
    );
    return {
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
      authType: config.authType ?? "oauth",
    };
  }
}

/**
 * Device-code (ChatGPT): show a user code, poll. Wraps the existing
 * `ChatGPTDeviceCodeClient` — `requestDeviceCode` for `start`, `pollForToken`
 * for `complete` (returns `null` while pending). The client owns OpenAI's
 * bespoke device handshake; this adapter only shapes it to `GrantStrategy`.
 */
export class DeviceCodeGrant implements GrantStrategy {
  async start(
    _config: OAuthProviderConfig,
    _scope: OAuthScope
  ): Promise<StartResult> {
    const client = new ChatGPTDeviceCodeClient();
    const result = await client.requestDeviceCode();
    return {
      mode: "device",
      userCode: result.userCode,
      deviceAuthId: result.deviceAuthId,
      interval: result.interval,
      verificationUrl: "https://auth.openai.com/codex/device",
    };
  }

  async complete(
    config: OAuthProviderConfig,
    _scope: OAuthScope,
    input: CompleteInput
  ): Promise<StoredCredential | null> {
    if (input.mode !== "device") {
      throw new Error("DeviceCodeGrant.complete requires a device-mode input");
    }
    const client = new ChatGPTDeviceCodeClient();
    const result = await client.pollForToken(input.deviceAuthId, input.userCode);
    if (!result) return null; // still pending
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: Date.now() + result.expiresIn * 1000,
      authType: config.authType ?? "device-code",
      accountId: result.accountId,
    };
  }
}

/**
 * Registry: provider id → config row. The only two OAuth providers.
 * Imported lazily by the routes to avoid a config→client→config cycle at
 * module-eval; the concrete configs live in `providers.ts`.
 */
export const GRANT_STRATEGIES: Record<
  "authorization-code" | "device-code",
  GrantStrategy
> = {
  "authorization-code": new AuthorizationCodeGrant(),
  "device-code": new DeviceCodeGrant(),
};

/** Pick the strategy for a config by its `grant` discriminator. */
export function grantStrategyFor(config: OAuthProviderConfig): GrantStrategy {
  const grant = config.grant ?? "authorization-code";
  return GRANT_STRATEGIES[grant];
}
