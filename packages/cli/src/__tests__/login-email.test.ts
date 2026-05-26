import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { loginCommand } from "../commands/login";
import * as context from "../internal/context";
import * as credentials from "../internal/credentials";

/**
 * Regression guard for `lobu login --email`: after the server accepts the
 * email claim, the command MUST keep polling and save the credential. An
 * earlier version checked the void result of the claim call as falsy and
 * returned immediately, so the email sent but no token was ever collected.
 */
describe("login --email (user_claimed)", () => {
  afterEach(() => {
    mock.restore();
  });

  function mockOAuthServer(): { calls: string[] } {
    const calls: string[] = [];
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      calls.push(url);
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return jsonResponse({
          issuer: "https://lobu.test",
          token_endpoint: "https://lobu.test/oauth/token",
          registration_endpoint: "https://lobu.test/oauth/register",
          device_authorization_endpoint:
            "https://lobu.test/oauth/device_authorization",
          grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code"],
          agent_auth: { claim_email_endpoint: "https://lobu.test/oauth/device/email" },
        });
      }
      if (url.endsWith("/oauth/register")) {
        return jsonResponse({ client_id: "agent-client" });
      }
      if (url.endsWith("/oauth/device_authorization")) {
        return jsonResponse({
          device_code: "dev-code",
          user_code: "ABCD-1234",
          verification_uri: "https://lobu.test/oauth/device",
          expires_in: 600,
          interval: 0,
        });
      }
      if (url.endsWith("/oauth/device/email")) {
        return jsonResponse({ status: "pending" }, 202);
      }
      if (url.endsWith("/oauth/token")) {
        return jsonResponse({
          access_token: "claimed-access-token",
          refresh_token: "claimed-refresh-token",
          expires_in: 3600,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return { calls };
  }

  test("sends the email claim, polls, and saves the collected credential", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod",
      url: "https://lobu.test/lobu/api/v1",
      source: "config",
    });
    spyOn(credentials, "loadCredentials").mockResolvedValue(null);
    const saveSpy = spyOn(credentials, "saveCredentials").mockResolvedValue();

    const originalFetch = globalThis.fetch;
    const { calls } = mockOAuthServer();
    try {
      await loginCommand({ email: "user@example.com", context: "prod" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    // It must have hit the claim endpoint AND gone on to poll the token endpoint.
    expect(calls.some((u) => u.endsWith("/oauth/device/email"))).toBe(true);
    expect(calls.some((u) => u.endsWith("/oauth/token"))).toBe(true);
    // ...and persisted the collected access token (the bug skipped this).
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0]?.[0]).toMatchObject({
      accessToken: "claimed-access-token",
    });
  });

  test("errors without polling when the server has no claim endpoint", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod",
      url: "https://lobu.test/lobu/api/v1",
      source: "config",
    });
    spyOn(credentials, "loadCredentials").mockResolvedValue(null);
    const saveSpy = spyOn(credentials, "saveCredentials").mockResolvedValue();

    const calls: string[] = [];
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      calls.push(url);
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return jsonResponse({
          token_endpoint: "https://lobu.test/oauth/token",
          registration_endpoint: "https://lobu.test/oauth/register",
          device_authorization_endpoint:
            "https://lobu.test/oauth/device_authorization",
          grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code"],
          // no agent_auth → email claim unsupported
        });
      }
      if (url.endsWith("/oauth/register")) return jsonResponse({ client_id: "c" });
      if (url.endsWith("/oauth/device_authorization")) {
        return jsonResponse({
          device_code: "d",
          user_code: "E-F",
          verification_uri: "https://lobu.test/oauth/device",
          expires_in: 600,
          interval: 0,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      await loginCommand({ email: "user@example.com", context: "prod" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.some((u) => u.endsWith("/oauth/device/email"))).toBe(false);
    expect(calls.some((u) => u.endsWith("/oauth/token"))).toBe(false);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
