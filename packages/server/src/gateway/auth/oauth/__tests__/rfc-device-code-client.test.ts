import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  OAuthClient,
  resolveDeviceVerificationUrl,
  withUserCodeQuery,
} from "../client.js";
import { grantStrategyFor } from "../grant-strategy.js";
import { TEST_CHATGPT_OAUTH, TEST_XAI_OAUTH } from "./fixtures.js";

/**
 * Pins the RFC 8628 device-code wire shape used by xAI SuperGrok OAuth,
 * plus generic verification_uri_complete / ?user_code= synthesis.
 */

interface Captured {
  url: string;
  contentType: string | null;
  rawBody: string;
}

type DeviceCodePayload = {
  device_code: string;
  user_code: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  interval?: number;
  expires_in?: number;
};

const originalFetch = globalThis.fetch;
let calls: Captured[];
let deviceCodePayload: DeviceCodePayload;

beforeEach(() => {
  calls = [];
  deviceCodePayload = {
    device_code: "dev-code-abc",
    user_code: "ABCD-1234",
    verification_uri: "https://accounts.x.ai/oauth2/device",
    interval: 5,
    expires_in: 1800,
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      contentType: headers.get("Content-Type"),
      rawBody: String(init?.body ?? ""),
    });

    if (url.includes("/oauth2/device/code")) {
      return new Response(JSON.stringify(deviceCodePayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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

describe("resolveDeviceVerificationUrl / withUserCodeQuery", () => {
  test("prefers verification_uri_complete as-is", () => {
    expect(
      resolveDeviceVerificationUrl({
        verificationUriComplete:
          "https://accounts.x.ai/oauth2/device?user_code=X3E9-KZ6B",
        verificationUri: "https://accounts.x.ai/oauth2/device",
        userCode: "IGNORED",
      }),
    ).toBe("https://accounts.x.ai/oauth2/device?user_code=X3E9-KZ6B");
  });

  test("synthesizes ?user_code= from bare verification_uri", () => {
    expect(
      resolveDeviceVerificationUrl({
        verificationUri: "https://accounts.x.ai/oauth2/device",
        userCode: "HZQY-6RSD",
      }),
    ).toBe("https://accounts.x.ai/oauth2/device?user_code=HZQY-6RSD");
  });

  test("does not double-append when user_code is already present", () => {
    expect(
      withUserCodeQuery(
        "https://accounts.x.ai/oauth2/device?user_code=KEEP",
        "OTHER",
      ),
    ).toBe("https://accounts.x.ai/oauth2/device?user_code=KEEP");
  });

  test("falls back to defaultVerificationUrl", () => {
    expect(
      resolveDeviceVerificationUrl({
        defaultVerificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
      }),
    ).toBe("https://auth.openai.com/codex/device?user_code=ABCD-1234");
  });
});

describe("OAuthClient RFC device-code (xAI)", () => {
  test("requestDeviceCode posts form-urlencoded and synthesizes ?user_code=", async () => {
    const client = new OAuthClient(TEST_XAI_OAUTH);
    const result = await client.requestDeviceCode();

    expect(result.userCode).toBe("ABCD-1234");
    expect(result.deviceAuthId).toBe("dev-code-abc");
    expect(result.verificationUrl).toBe(
      "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
    );
    expect(result.interval).toBe(5);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(TEST_XAI_OAUTH.deviceCodeUrl);
    expect(calls[0]!.contentType).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(calls[0]!.rawBody);
    expect(params.get("client_id")).toBe(TEST_XAI_OAUTH.clientId);
    expect(params.get("scope")).toBe(TEST_XAI_OAUTH.scope);
  });

  test("prefers provider verification_uri_complete over synthesis", async () => {
    deviceCodePayload = {
      device_code: "dev-code-abc",
      user_code: "ABCD-1234",
      verification_uri: "https://accounts.x.ai/oauth2/device",
      verification_uri_complete:
        "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234&src=provider",
      interval: 5,
    };
    const client = new OAuthClient(TEST_XAI_OAUTH);
    const result = await client.requestDeviceCode();
    expect(result.verificationUrl).toBe(
      "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234&src=provider",
    );
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
  test("dispatches device-code and maps deviceAuthId with prefilled URL", async () => {
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
    expect(started.verificationUrl).toBe(
      "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
    );

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

describe("OAuthClient OpenAI device-auth (ChatGPT)", () => {
  test("requestDeviceCode prefills defaultVerificationUrl with user_code", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/deviceauth/usercode")) {
        return new Response(
          JSON.stringify({
            device_auth_id: "dev_abc",
            user_code: "WXYZ-9876",
            interval: 5,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const client = new OAuthClient(TEST_CHATGPT_OAUTH);
      const result = await client.requestDeviceCode();
      expect(result.userCode).toBe("WXYZ-9876");
      expect(result.deviceAuthId).toBe("dev_abc");
      expect(result.verificationUrl).toBe(
        "https://auth.openai.com/codex/device?user_code=WXYZ-9876",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
