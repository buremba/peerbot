import { describe, expect, test } from "bun:test";
import { ApplyClient } from "../client.js";

describe("ApplyClient", () => {
  test("patchAgentMetadata uses PATCH /agents/:agentId", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch
    );

    await client.patchAgentMetadata("triage", {
      name: "Triage",
      description: "Updated",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://example.test/api/acme/agents/triage");
    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "Triage",
      description: "Updated",
    });
  });

  test("listWatchers GETs /watchers and unwraps the list", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({ watchers: [{ slug: "digest", name: "Digest" }] }),
          { status: 200 }
        );
      }) as typeof fetch
    );

    const watchers = await client.listWatchers();
    expect(calls[0]?.url).toBe("https://example.test/api/acme/watchers");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(watchers).toEqual([{ slug: "digest", name: "Digest" }]);
  });

  test("createWatcher POSTs manage_watchers with action=create and no entity_id", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ action: "create" }), {
          status: 200,
        });
      }) as typeof fetch
    );

    await client.createWatcher({
      slug: "digest",
      name: "Digest",
      prompt: "Produce a digest.",
      extraction_schema: { type: "object" },
      schedule: "0 9 * * 1",
    });

    expect(calls[0]?.url).toBe("https://example.test/api/acme/manage_watchers");
    expect(calls[0]?.init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toEqual({
      action: "create",
      slug: "digest",
      name: "Digest",
      prompt: "Produce a digest.",
      extraction_schema: { type: "object" },
      schedule: "0 9 * * 1",
    });
    expect("entity_id" in body).toBe(false);
  });
});
