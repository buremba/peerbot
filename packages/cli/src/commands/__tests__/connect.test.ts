/**
 * Stage 4 — `lobu connect` poll + slug helpers.
 *
 * The connect command opens the cloud connect URL, then polls the cloud's
 * /oauth/connection-token with the login credential until consent completes.
 * These tests pin the poll classifier (the loop's decision logic) and the
 * local-connection slug derivation.
 */

import { describe, expect, mock, test } from "bun:test";
import { defaultSlug, pollConnectionToken } from "../connect.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("defaultSlug", () => {
  test("derives a slug from a dotted connector key", () => {
    expect(defaultSlug("gcal.calendar")).toBe("gcal-calendar");
  });

  test("lowercases and strips leading/trailing separators", () => {
    expect(defaultSlug("  Demo.OAuth  ")).toBe("demo-oauth");
  });

  test("falls back to `managed` for an all-symbol key", () => {
    expect(defaultSlug("...")).toBe("managed");
  });
});

describe("pollConnectionToken", () => {
  const url = "https://app.lobu.ai/oauth/connection-token";
  const body = { org: "acme", connector_key: "gcal.calendar" };

  test("200 → ok (consent completed)", async () => {
    const fetchMock = mock(async () =>
      jsonResponse(200, { access_token: "tok", expires_at: null })
    );
    const result = await pollConnectionToken(
      url,
      "login-token",
      body,
      fetchMock as typeof fetch
    );
    expect(result.ok).toBe(true);
    expect(result.terminal).toBe(false);
    // It sent the login token as a Bearer to the connection-token endpoint.
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer login-token"
    );
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  test("404 → keep polling (not connected yet, non-terminal)", async () => {
    const fetchMock = mock(async () =>
      jsonResponse(404, { error: "not_found" })
    );
    const result = await pollConnectionToken(
      url,
      "t",
      body,
      fetchMock as typeof fetch
    );
    expect(result.ok).toBe(false);
    expect(result.terminal).toBe(false);
  });

  test("403 → terminal (membership / scope problem)", async () => {
    const fetchMock = mock(async () =>
      jsonResponse(403, {
        error: "forbidden",
        error_description: "Not a member of this organization",
      })
    );
    const result = await pollConnectionToken(
      url,
      "t",
      body,
      fetchMock as typeof fetch
    );
    expect(result.ok).toBe(false);
    expect(result.terminal).toBe(true);
    expect(result.message).toMatch(/Not a member/);
  });

  test("401 → terminal (auth failed)", async () => {
    const fetchMock = mock(async () =>
      jsonResponse(401, { error: "invalid_token" })
    );
    const result = await pollConnectionToken(
      url,
      "t",
      body,
      fetchMock as typeof fetch
    );
    expect(result.ok).toBe(false);
    expect(result.terminal).toBe(true);
    expect(result.message).toMatch(/Authentication failed/);
  });

  test("network error → non-terminal (keep polling through blips)", async () => {
    const fetchMock = mock(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await pollConnectionToken(
      url,
      "t",
      body,
      fetchMock as typeof fetch
    );
    expect(result.ok).toBe(false);
    expect(result.terminal).toBe(false);
  });
});
