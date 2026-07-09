import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OAuthClient } from "../client.js";
import { grantStrategyFor } from "../grant-strategy.js";
import { TEST_XAI_OAUTH } from "./fixtures.js";

/**
 * Pins the RFC 8628 device-code wire shape used by xAI SuperGrok OAuth.
 */

interface Captured {
  url: string;
  contentType: string | null;
  rawBody: string;
}

const originalFetch = globalThis.fetch;
let calls: Captured[];

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      contentType: headers.get("Content-Type"),
      rawBody: String(init?.body ?? ""),
    });

    if (url.includes("/oauth2/device/code")) {
      return new Response(
        JSON.stringify({
          device_code: "dev-code-abc",
          user_code: "ABCD-1234",
          verification_uri: "https://accounts.x.ai/oauth2/device",
          interval: 5,
          expires_in: 1800,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.includes("/oauth2/token")) {
      const body = String(init?.body ?? "");
      if (body.includes("grant_type=refresh_token")) {
        return new Response(
          JSON.stringify({
            access_token: "access-refreshed",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (body.includes("device_code=pending")) {
        return new Response(
          JSON.stringify({ error: "authorization_pending" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          access_token: "access-ok",
          refresh_token: "refresh-ok",
          expires_in: 7200,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OAuthClient RFC device-code (xAI)", () => {
  test("requestDeviceCode posts form-urlencoded client_id+scope", async () => {
    const client = new OAuthClient(TEST_XAI_OAUTH);
    const result = await client.requestDeviceCode();

    expect(result.userCode).toBe("ABCD-1234");
    expect(result.deviceAuthId).toBe("dev-code-abc");
    expect(result.verificationUrl).toBe("https://accounts.x.ai/oauth2/device");
    expect(result.interval).toBe(5);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(TEST_XAI_OAUTH.deviceCodeUrl);
    expect(calls[0]!.contentType).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(calls[0]!.rawBody);
    expect(params.get("client_id")).toBe(TEST_XAI_OAUTH.clientId);
    expect(params.get("scope")).toBe(TEST_XAI_OAUTH.scope);
  });

  test("pollForToken returns null on authorization_pending", async () => {
    const client = new OAuthClient(TEST_XAI_OAUTH);
    expect(await client.pollForToken("pending")).toBeNull();
  });

  test("pollForToken exchanges device_code via form grant", async () => {
    const client = new OAuthClient(TEST_XAI_OAUTH);
    const token = await client.pollForToken("dev-code-abc");
    expect(token).toMatchObject({
      accessToken: "access-ok",
      refreshToken: "refresh-ok",
      expiresIn: 7200,
    });

    const poll = calls.find((c) => c.url === TEST_XAI_OAUTH.tokenUrl);
    expect(poll).toBeDefined();
    expect(poll!.contentType).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(poll!.rawBody);
    expect(params.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:device_code",
    );
    expect(params.get("device_code")).toBe("dev-code-abc");
    expect(params.get("client_id")).toBe(TEST_XAI_OAUTH.clientId);
  });

  test("refreshToken preserves refresh when response omits it", async () => {
    const client = new OAuthClient(TEST_XAI_OAUTH);
    const creds = await client.refreshToken("refresh-keep");
    expect(creds.accessToken).toBe("access-refreshed");
    expect(creds.refreshToken).toBe("refresh-keep");
  });
});

describe("grantStrategyFor(xai)", () => {
  test("dispatches device-code and maps deviceAuthId", async () => {
    const strategy = grantStrategyFor(TEST_XAI_OAUTH);
    const started = await strategy.start(TEST_XAI_OAUTH, {
      kind: "org",
      slug: "org1",
      organizationId: "org1",
      userId: "user1",
    });
    expect(started.mode).toBe("device");
    if (started.mode !== "device") throw new Error("expected device");
    expect(started.userCode).toBe("ABCD-1234");
    expect(started.deviceAuthId).toBe("dev-code-abc");

    const completed = await strategy.complete(
      TEST_XAI_OAUTH,
      {
        kind: "org",
        slug: "org1",
        organizationId: "org1",
        userId: "user1",
      },
      {
        mode: "device",
        deviceAuthId: started.deviceAuthId,
        userCode: started.userCode,
      },
    );
    expect(completed).toMatchObject({
      accessToken: "access-ok",
      refreshToken: "refresh-ok",
      authType: "device-code",
    });
  });
});
