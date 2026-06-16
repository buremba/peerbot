import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChatGPTDeviceCodeClient } from "../device-code-client.js";

/**
 * Regression guard for the ChatGPT (OpenAI Codex) device-code OAuth flow.
 *
 * The OAuth token exchange at https://auth.openai.com/oauth/token MUST be
 * `application/x-www-form-urlencoded` (RFC 6749 §4.1.3) — the same class of bug
 * that broke Claude login when its exchange was sent as JSON (see
 * oauth/__tests__/client-token-format.test.ts). The device-auth endpoints
 * (/api/accounts/deviceauth/*) are OpenAI's own JSON API and correctly use
 * application/json. These tests pin both, without hitting the network.
 */

const TOKEN_EXCHANGE_URL = "https://auth.openai.com/oauth/token";
const DEVICE_CODE_URL =
  "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";

interface Captured {
  url: string;
  contentType: string | null;
  rawBody: string;
}

// A throwaway unsigned JWT carrying the account claim, so extractAccountId works.
function fakeJwt(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url"
  );
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    })
  ).toString("base64url");
  return `${header}.${payload}.sig`;
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

    if (url === DEVICE_CODE_URL) {
      return new Response(
        JSON.stringify({
          device_auth_id: "dev_abc",
          user_code: "ABCD-1234",
          interval: 5,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url === DEVICE_TOKEN_URL) {
      // User has authorized: return the authorization_code + verifier.
      return new Response(
        JSON.stringify({
          authorization_code: "authcode_xyz",
          code_verifier: "verifier_abc",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url === TOKEN_EXCHANGE_URL) {
      return new Response(
        JSON.stringify({
          access_token: fakeJwt("acc_123"),
          refresh_token: "rt_test",
          expires_in: 864_000,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("ChatGPTDeviceCodeClient encoding", () => {
  test("device-code request uses JSON (OpenAI's device-auth API)", async () => {
    const client = new ChatGPTDeviceCodeClient();
    await client.requestDeviceCode();

    const call = calls.find((c) => c.url === DEVICE_CODE_URL);
    expect(call).toBeDefined();
    expect(call!.contentType).toBe("application/json");
    expect(JSON.parse(call!.rawBody).client_id).toBeTruthy();
  });

  test("OAuth token exchange is form-encoded (RFC 6749) — the Claude-class regression guard", async () => {
    const client = new ChatGPTDeviceCodeClient();
    const result = await client.pollForToken("dev_abc", "ABCD-1234");

    expect(result).not.toBeNull();
    expect(result!.refreshToken).toBe("rt_test");
    expect(result!.accountId).toBe("acc_123");

    const exchange = calls.find((c) => c.url === TOKEN_EXCHANGE_URL);
    expect(exchange).toBeDefined();
    // The critical assertion: must NOT be application/json.
    expect(exchange!.contentType).toBe("application/x-www-form-urlencoded");

    const form = new URLSearchParams(exchange!.rawBody);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("authcode_xyz");
    expect(form.get("code_verifier")).toBe("verifier_abc");
    expect(form.get("redirect_uri")).toBe(
      "https://auth.openai.com/deviceauth/callback"
    );
    expect(form.get("client_id")).toBeTruthy();
    // Sanity: it must not be JSON.
    expect(exchange!.rawBody.trim().startsWith("{")).toBe(false);
  });

  test("poll returns null (pending) on 403 without authorizing", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === DEVICE_TOKEN_URL) return new Response("", { status: 403 });
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof globalThis.fetch;

    const client = new ChatGPTDeviceCodeClient();
    expect(await client.pollForToken("dev_abc", "ABCD-1234")).toBeNull();
  });

  test("refresh exchange is form-encoded with grant_type=refresh_token", async () => {
    const client = new ChatGPTDeviceCodeClient();
    const creds = await client.refreshToken("rt_old");

    expect(creds.accessToken).toBe(fakeJwt("acc_123"));
    expect(creds.refreshToken).toBe("rt_test"); // rotated value from the response

    const refresh = calls.find((c) => c.url === TOKEN_EXCHANGE_URL);
    expect(refresh).toBeDefined();
    expect(refresh!.contentType).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(refresh!.rawBody);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("rt_old");
    expect(form.get("client_id")).toBeTruthy();
    expect(form.get("scope")).toBeTruthy();
    expect(refresh!.rawBody.trim().startsWith("{")).toBe(false);
  });

  test("refresh preserves the existing refresh_token when the response omits it", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === TOKEN_EXCHANGE_URL) {
        return new Response(
          // No refresh_token in the response — OpenAI doesn't always rotate it.
          JSON.stringify({ access_token: fakeJwt("acc_9"), expires_in: 864_000 }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof globalThis.fetch;

    const client = new ChatGPTDeviceCodeClient();
    const creds = await client.refreshToken("rt_keep");
    expect(creds.refreshToken).toBe("rt_keep"); // not wiped
  });
});
