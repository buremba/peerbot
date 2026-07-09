/**
 * Slack Web API HTTP-encoding contract. Slack's READ methods
 * (`conversations.members`/`.list`, `users.info`, …) accept ONLY
 * `application/x-www-form-urlencoded` — a JSON body returns `invalid_arguments`,
 * which would silently fail-close the ACL sync (no audience ever materializes).
 * Integration tests stub `conversationMembers`, so this guards the real wire
 * format that those stubs hide.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { createSlackWebApi } from "../slack-web.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("createSlackWebApi wire format", () => {
  test("posts conversations.members as form-urlencoded (NOT json) and paginates", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const pages = [
      { ok: true, members: ["U1", "U2"], response_metadata: { next_cursor: "CUR" } },
      { ok: true, members: ["U3"], response_metadata: { next_cursor: "" } },
    ];
    let i = 0;
    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      const body = pages[i++];
      return { json: async () => body } as Response;
    }) as unknown as typeof fetch;

    const api = createSlackWebApi();
    const members = await api.conversationMembers("xoxb-token", "C123");

    expect(members).toEqual(["U1", "U2", "U3"]);
    expect(calls.length).toBe(2);

    const [url, init] = calls[0]!;
    expect(url).toBe("https://slack.com/api/conversations.members");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toMatch(/application\/x-www-form-urlencoded/);
    expect(headers.Authorization).toBe("Bearer xoxb-token");
    // Body is form-encoded, so it parses as URLSearchParams (a JSON body would not).
    const body = new URLSearchParams(init.body as string);
    expect(body.get("channel")).toBe("C123");
    expect(body.get("limit")).toBe("200");
    // Second page forwards the cursor.
    const secondBody = new URLSearchParams(calls[1]![1].body as string);
    expect(secondBody.get("cursor")).toBe("CUR");
  });

  test("throws with the Slack error code when ok is false", async () => {
    globalThis.fetch = mock(async () => ({
      json: async () => ({ ok: false, error: "invalid_arguments" }),
    })) as unknown as typeof fetch;

    const api = createSlackWebApi();
    await expect(api.conversationMembers("xoxb-token", "C123")).rejects.toThrow(
      /invalid_arguments/,
    );
  });
});

describe("exchangeOAuthCode install shapes", () => {
  const OAUTH_ARGS = {
    clientId: "cid",
    clientSecret: "secret",
    code: "the-code",
    redirectUri: "https://app.lobu.ai/lobu/slack/oauth_callback",
  };

  test("per-workspace install returns the team id as the identity key", async () => {
    globalThis.fetch = mock(async () => ({
      json: async () => ({
        ok: true,
        access_token: "xoxb-ws",
        team: { id: "T123", name: "Acme" },
        enterprise: null,
        is_enterprise_install: false,
        bot_user_id: "B1",
        authed_user: { id: "U1" },
      }),
    })) as unknown as typeof fetch;

    const api = createSlackWebApi();
    const result = await api.exchangeOAuthCode(OAUTH_ARGS);

    expect(result.teamId).toBe("T123");
    expect(result.teamName).toBe("Acme");
    expect(result.isEnterpriseInstall).toBe(false);
    expect(result.enterpriseId).toBeNull();
  });

  test("org-wide enterprise install (no team id) resolves the enterprise id as the identity key", async () => {
    // Grid org-wide install: Slack's oauth.v2.access returns NO `team` — the app
    // is installed at the enterprise level — but sets `is_enterprise_install:true`
    // and `enterprise:{id,name}`. The exchange must NOT reject this as a failed
    // install; the enterprise id is the routing/identity key.
    globalThis.fetch = mock(async () => ({
      json: async () => ({
        ok: true,
        access_token: "xoxb-ent",
        team: null,
        enterprise: { id: "E0BDSKL1KJL", name: "LobuSandbox" },
        is_enterprise_install: true,
        bot_user_id: "B2",
        authed_user: { id: "U2" },
      }),
    })) as unknown as typeof fetch;

    const api = createSlackWebApi();
    const result = await api.exchangeOAuthCode(OAUTH_ARGS);

    expect(result.isEnterpriseInstall).toBe(true);
    expect(result.enterpriseId).toBe("E0BDSKL1KJL");
    // The enterprise id stands in as the identity key so the pending row,
    // claim ref, and enterprise-fallback routing all get a stable non-null id.
    expect(result.teamId).toBe("E0BDSKL1KJL");
    expect(result.teamName).toBe("LobuSandbox");
  });

  test("no team id AND not an enterprise install still throws", async () => {
    globalThis.fetch = mock(async () => ({
      json: async () => ({
        ok: true,
        access_token: "xoxb-x",
        team: null,
        enterprise: null,
        is_enterprise_install: false,
      }),
    })) as unknown as typeof fetch;

    const api = createSlackWebApi();
    await expect(api.exchangeOAuthCode(OAUTH_ARGS)).rejects.toThrow(
      /no team id/,
    );
  });
});
