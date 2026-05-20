import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { tokenCreateCommand } from "../commands/token";
import * as context from "../internal/context";
import * as credentials from "../internal/credentials";

describe("token create", () => {
  afterEach(() => {
    mock.restore();
    delete process.env.LOBU_API_TOKEN;
  });

  test("creates an org-scoped PAT using the current OAuth login", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod",
      url: "https://app.lobu.ai/api/v1",
      source: "config",
    });
    spyOn(credentials, "getToken").mockResolvedValue("oauth-access-token");

    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://app.lobu.ai/api/acme/tokens");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer oauth-access-token",
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        name: "prod-server",
        scope: "mcp:read mcp:write",
      });
      return new Response(
        JSON.stringify({
          token: {
            id: 1,
            token: "owl_pat_test",
            token_prefix: "owl_pat_test",
            name: "prod-server",
            scope: "mcp:read mcp:write",
            expires_at: null,
            created_at: "2026-01-01T00:00:00.000Z",
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      );
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(
      () => true
    );

    try {
      await tokenCreateCommand({ org: "acme", name: "prod-server", raw: true });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith("owl_pat_test\n");
  });
});
