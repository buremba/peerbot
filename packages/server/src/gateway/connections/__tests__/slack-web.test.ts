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
