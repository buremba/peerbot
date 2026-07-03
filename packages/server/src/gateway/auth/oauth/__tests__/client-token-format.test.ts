import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OAuthClient } from "../client.js";
import { CLAUDE_PROVIDER, type OAuthProviderConfig } from "../providers.js";

/**
 * Regression guard for the Claude OAuth "Token exchange failed: 400 Bad Request"
 * incident. Anthropic's token endpoint requires an
 * `application/x-www-form-urlencoded` body (RFC 6749 §4.1.3); when the gateway
 * sent JSON, Anthropic failed to parse the body and returned
 * `invalid_grant: Invalid 'redirect_uri'`. The fix is `tokenRequestFormat:
 * "form"` on CLAUDE_PROVIDER. These tests pin the request shape without hitting
 * the network.
 */

interface CapturedRequest {
  url: string;
  contentType: string | null;
  rawBody: string;
}

const originalFetch = globalThis.fetch;
let captured: CapturedRequest | null;

function stubFetch(): void {
  captured = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    captured = {
      url: typeof input === "string" ? input : input.toString(),
      contentType: headers.get("Content-Type"),
      rawBody: String(init?.body ?? ""),
    };
    return new Response(
      JSON.stringify({
        access_token: "at_test",
        refresh_token: "rt_test",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "user:inference",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof globalThis.fetch;
}

beforeEach(stubFetch);
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OAuthClient token-request encoding", () => {
  test("Claude exchange POSTs form-encoded body with the genuine field set", async () => {
    const client = new OAuthClient(CLAUDE_PROVIDER);

    await client.exchangeCodeForToken("auth_code_xyz", "verifier_abc", undefined, "state_123");

    expect(captured).not.toBeNull();
    const req = captured!;
    expect(req.url).toBe(CLAUDE_PROVIDER.tokenUrl);
    // The bug: this was "application/json". Anthropic requires form-encoding.
    expect(req.contentType).toBe("application/x-www-form-urlencoded");

    // Body must be parseable as form data with the exact genuine field set.
    const form = new URLSearchParams(req.rawBody);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("auth_code_xyz");
    expect(form.get("code_verifier")).toBe("verifier_abc");
    expect(form.get("state")).toBe("state_123");
    expect(form.get("client_id")).toBe(CLAUDE_PROVIDER.clientId);
    expect(form.get("redirect_uri")).toBe(CLAUDE_PROVIDER.redirectUri);
    // The genuine claude-code exchange does NOT send expires_in.
    expect(form.get("expires_in")).toBeNull();
    // Sanity: it must not be JSON.
    expect(req.rawBody.trim().startsWith("{")).toBe(false);
  });

  test("a provider without tokenRequestFormat still uses JSON (no regression for other providers)", async () => {
    const jsonProvider: OAuthProviderConfig = {
      id: "external-auth",
      name: "External Auth",
      clientId: "client_json",
      authUrl: "https://provider.example/authorize",
      tokenUrl: "https://provider.example/token",
      redirectUri: "https://app.example/callback",
      scope: "openid",
      requireRefreshToken: false,
    };
    const client = new OAuthClient(jsonProvider);

    await client.exchangeCodeForToken("code_j", "verifier_j");

    expect(captured).not.toBeNull();
    const req = captured!;
    expect(req.contentType).toBe("application/json");
    const parsed = JSON.parse(req.rawBody);
    expect(parsed.grant_type).toBe("authorization_code");
    expect(parsed.client_id).toBe("client_json");
  });

  // #3 extraAuthParams echo: buildAuthUrl must surface CLAUDE_PROVIDER's
  // `extraAuthParams: { code: "true" }` in the authorize URL. The genuine
  // claude-code login sends `code=true`; dropping it changes the flow Anthropic
  // runs and breaks the paste-code exchange.
  test("buildAuthUrl echoes extraAuthParams (code=true) into the authorize URL", () => {
    const client = new OAuthClient(CLAUDE_PROVIDER);
    const url = new URL(client.buildAuthUrl("state_x", "verifier_y"));

    expect(url.searchParams.get("code")).toBe("true");
    // Sanity: the standard PKCE params are present alongside it.
    expect(url.searchParams.get("client_id")).toBe(CLAUDE_PROVIDER.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(
      CLAUDE_PROVIDER.redirectUri
    );
    expect(url.searchParams.get("state")).toBe("state_x");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});
