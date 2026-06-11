import { describe, expect, test } from "bun:test";
import { ApiError } from "../../../memory/_lib/errors.js";
import { ApplyClient, isDuplicateError } from "../client.js";

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
    // `include_details=true` so the apply diff can see prompt /
    // extraction_schema / reactions_guidance / etc. for drift detection.
    expect(calls[0]?.url).toBe(
      "https://example.test/api/acme/watchers?include_details=true"
    );
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
      agentId: "triage",
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
      agent_id: "triage",
      name: "Digest",
      prompt: "Produce a digest.",
      extraction_schema: { type: "object" },
      schedule: "0 9 * * 1",
    });
    expect("entity_id" in body).toBe(false);
  });

  test("listOrgs reads organizations from the OAuth userinfo endpoint", async () => {
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (url, init) => {
        expect(String(url)).toBe("https://example.test/oauth/userinfo");
        expect(init?.method).toBe("GET");
        return new Response(
          JSON.stringify({
            sub: "u1",
            organizations: [
              { id: "org_1", slug: "acme", name: "Acme", role: "owner" },
              { id: "org_2", slug: "office-bot" },
              { slug: "no-id-skip" },
            ],
          }),
          { status: 200 }
        );
      }) as typeof fetch
    );

    expect(await client.listOrgs()).toEqual([
      { id: "org_1", slug: "acme", name: "Acme" },
      { id: "org_2", slug: "office-bot" },
    ]);
  });

  test("listOrgs returns [] when userinfo has no organizations", async () => {
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async () =>
        new Response(JSON.stringify({ sub: "u1" }), {
          status: 200,
        })) as typeof fetch
    );
    expect(await client.listOrgs()).toEqual([]);
  });
});

describe("ApplyClient — prune", () => {
  function recordingClient(responseBody: unknown = { success: true }) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify(responseBody), { status: 200 });
      }) as typeof fetch
    );
    return { calls, client };
  }

  test("deleteEntityType POSTs manage_entity_schema delete by slug", async () => {
    const { calls, client } = recordingClient();
    await client.deleteEntityType("lead");
    expect(calls[0]?.url).toBe(
      "https://example.test/api/acme/manage_entity_schema"
    );
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      schema_type: "entity_type",
      action: "delete",
      slug: "lead",
    });
  });

  test("deleteRelationshipType POSTs manage_entity_schema delete by slug", async () => {
    const { calls, client } = recordingClient();
    await client.deleteRelationshipType("works-with");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      schema_type: "relationship_type",
      action: "delete",
      slug: "works-with",
    });
  });

  test("deleteWatcher POSTs manage_watchers delete with watcher_ids array", async () => {
    const { calls, client } = recordingClient();
    await client.deleteWatcher("42");
    expect(calls[0]?.url).toBe("https://example.test/api/acme/manage_watchers");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      action: "delete",
      watcher_ids: ["42"],
    });
  });

  test("upsertEntityType POSTs a nested backing for a derived type", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch
    );

    await client.upsertEntityType({
      slug: "subscription",
      backing: {
        sql: "SELECT company_id, SUM(amount) AS spend FROM events GROUP BY company_id",
      },
    });

    expect(calls[0]?.url).toBe(
      "https://example.test/api/acme/manage_entity_schema"
    );
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.action).toBe("create");
    expect(body.backing).toEqual({
      sql: "SELECT company_id, SUM(amount) AS spend FROM events GROUP BY company_id",
    });
  });

  test("listEntityTypes hoists backing_sql to a { sql } backing (derived type)", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({
            entity_types: [
              {
                slug: "subscription",
                metadata_schema: { type: "object", properties: {} },
                backing_sql: "SELECT 1 AS x",
              },
            ],
          }),
          { status: 200 }
        );
      }) as typeof fetch
    );

    const types = await client.listEntityTypes();
    expect(types[0]?.backing).toEqual({ sql: "SELECT 1 AS x" });
  });

  test("upsertEntityType POSTs backing:null for a stored type", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch
    );

    await client.upsertEntityType({ slug: "company", name: "Company" });

    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.backing).toBeNull();
  });
});

// Issue #1177: a 422 schema-validation error from `create` must NOT be
// mistaken for "already exists" (which retried as `update` and buried the
// real message under "Entity type not found").
describe("isDuplicateError", () => {
  test("coded duplicates are duplicates", () => {
    for (const code of [
      "entity_type_exists",
      "relationship_type_exists",
      "already_exists",
    ]) {
      expect(
        isDuplicateError(
          new ApiError(`POST /x failed: [${code}] thing already exists`, 409)
        )
      ).toBe(true);
    }
  });

  test("bare 409 without a code is still a duplicate", () => {
    expect(
      isDuplicateError(new ApiError("POST /x failed: conflict", 409))
    ).toBe(true);
  });

  test("422 validation error is NOT a duplicate", () => {
    expect(
      isDuplicateError(
        new ApiError(
          "POST /x failed: [invalid_schema] At most 4 metadata fields can have x-table-column=true.",
          422
        )
      )
    ).toBe(false);
  });

  test("code-less 400 is NOT a duplicate", () => {
    expect(
      isDuplicateError(new ApiError("POST /x failed: slug is required", 400))
    ).toBe(false);
  });

  test("missing status is NOT a duplicate", () => {
    expect(isDuplicateError(new ApiError("Invalid JSON from /x"))).toBe(false);
  });
});

describe("ApplyClient — upsert create/update flow", () => {
  test("create → coded 409 duplicate → retries as update (idempotent)", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (url, init) => {
        calls.push({ url: String(url), init });
        const body = JSON.parse(String(init?.body));
        if (body.action === "create") {
          return new Response(
            JSON.stringify({
              error:
                "[entity_type_exists] Entity type with slug 'task' already exists",
            }),
            { status: 409 }
          );
        }
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch
    );

    const result = await client.upsertEntityType({
      slug: "task",
      name: "Task",
    });
    expect(result).toEqual({ updated: true });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0]?.init?.body)).action).toBe("create");
    expect(JSON.parse(String(calls[1]?.init?.body)).action).toBe("update");
  });

  test("create → 422 validation error surfaces verbatim, no update retry", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({
            error:
              "[invalid_schema] At most 4 metadata fields can have x-table-column=true.",
          }),
          { status: 422 }
        );
      }) as typeof fetch
    );

    await expect(
      client.upsertEntityType({ slug: "task", name: "Task" })
    ).rejects.toThrow(/At most 4 metadata fields can have x-table-column=true/);
    // The doomed `update` retry (which produced the misleading
    // "Entity type 'task' not found") must not happen.
    expect(calls).toHaveLength(1);
  });
});
