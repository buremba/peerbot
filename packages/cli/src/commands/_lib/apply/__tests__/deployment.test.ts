import { describe, expect, test } from "bun:test";
import { ApplyClient } from "../client.js";
import type { DesiredState } from "../desired-state.js";
import type { DiffRow } from "../diff.js";
import {
  buildCountsByKind,
  collectGitInfo,
  computeManifestHash,
  mintApplyId,
} from "../deployment.js";

function baseState(overrides: Partial<DesiredState> = {}): DesiredState {
  return {
    agents: [],
    prune: false,
    memorySchema: { entityTypes: [], relationshipTypes: [] },
    watchers: [],
    connectors: { definitions: [], authProfiles: [], connections: [] },
    providers: [],
    requiredSecrets: [],
    ...overrides,
  };
}

describe("mintApplyId", () => {
  test("matches the server-side x-lobu-apply-id validation pattern", () => {
    const id = mintApplyId();
    // Must stay in sync with APPLY_ID_RE in packages/server/src/utils/apply-context.ts.
    expect(id).toMatch(/^apl_[A-Za-z0-9-]{1,48}$/);
  });
});

describe("computeManifestHash", () => {
  test("is deterministic and prefixed", () => {
    const a = computeManifestHash(baseState());
    const b = computeManifestHash(baseState());
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("secret VALUES never affect the hash; structure does", () => {
    const withKey = (value: string, slug = "z-ai") =>
      baseState({
        providers: [{ slug, kind: "z-ai", apiKey: value, capabilities: {} }],
      });
    // Rotating a secret is not a config change.
    expect(computeManifestHash(withKey("sk-live-1"))).toBe(
      computeManifestHash(withKey("sk-live-2"))
    );
    // Renaming the provider is.
    expect(computeManifestHash(withKey("sk-live-1"))).not.toBe(
      computeManifestHash(withKey("sk-live-1", "other-provider"))
    );
  });

  test("agent providerKeys and denylisted keys are redacted before hashing", () => {
    const agent = {
      agentId: "a1",
      name: "A1",
      settings: { networkConfig: { allowedDomains: ["github.com"] } },
      platforms: [
        {
          platform: "telegram",
          config: { botToken: "1234:real-telegram-token" },
        },
      ],
      providerKeys: [{ providerId: "anthropic", value: "sk-ant-real" }],
    } as unknown as DesiredState["agents"][number];

    const one = computeManifestHash(baseState({ agents: [agent] }));
    const two = computeManifestHash(
      baseState({
        agents: [
          {
            ...agent,
            platforms: [
              {
                platform: "telegram",
                config: { botToken: "1234:DIFFERENT" },
              },
            ] as typeof agent.platforms,
            providerKeys: [{ providerId: "anthropic", value: "sk-ant-OTHER" }],
          },
        ],
      })
    );
    expect(one).toBe(two);
  });

  test("a NON-secret platform config change DOES change the hash", () => {
    const agentWith = (chatId: string) =>
      ({
        agentId: "a1",
        name: "A1",
        settings: {},
        platforms: [
          {
            platform: "telegram",
            config: { chatId, botToken: "1234:secret" },
          },
        ],
        providerKeys: [],
      }) as unknown as DesiredState["agents"][number];
    expect(
      computeManifestHash(baseState({ agents: [agentWith("chat-1")] }))
    ).not.toBe(
      computeManifestHash(baseState({ agents: [agentWith("chat-2")] }))
    );
  });
});

describe("buildCountsByKind", () => {
  test("tallies create/update/delete per kind and ignores noop/drift", () => {
    const rows = [
      { kind: "agent", verb: "create" },
      { kind: "agent", verb: "noop" },
      { kind: "watcher", verb: "update" },
      { kind: "watcher", verb: "update" },
      { kind: "connection", verb: "drift" },
      { kind: "feed", verb: "delete" },
    ] as unknown as DiffRow[];
    expect(buildCountsByKind(rows)).toEqual({
      agent: { create: 1 },
      watcher: { update: 2 },
      feed: { delete: 1 },
    });
  });
});

describe("collectGitInfo", () => {
  test("returns nulls outside a git work tree", () => {
    const info = collectGitInfo("/");
    expect(info.sha).toBeNull();
    expect(info.dirty).toBeNull();
  });
});

describe("ApplyClient x-lobu-apply-id threading", () => {
  test("every request carries the header when applyId is configured", async () => {
    const seen: Array<{ url: string; applyId: string | null }> = [];
    const fetchImpl = (async (input: any, init?: RequestInit) => {
      const headers = new Headers(init?.headers as HeadersInit);
      seen.push({
        url: String(input),
        applyId: headers.get("x-lobu-apply-id"),
      });
      return new Response(JSON.stringify({ agents: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const applyId = mintApplyId();
    const client = new ApplyClient(
      { apiBaseUrl: "http://api.test", orgSlug: "acme", token: "t", applyId },
      fetchImpl
    );
    await client.postDeploymentSummary({
      apply_id: applyId,
      status: "succeeded",
      counts: { create: 0, update: 0, noop: 0, drift: 0, delete: 0 },
      counts_by_kind: {},
      manifest_hash: "sha256:0",
      git_sha: null,
      git_dirty: null,
      cli_version: "0.0.0",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("http://api.test/api/acme/deployments");
    expect(seen[0].applyId).toBe(applyId);
  });

  test("no header leaks when applyId is not configured", async () => {
    let sawHeader: string | null = "sentinel";
    const fetchImpl = (async (_input: any, init?: RequestInit) => {
      sawHeader = new Headers(init?.headers as HeadersInit).get(
        "x-lobu-apply-id"
      );
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const client = new ApplyClient(
      { apiBaseUrl: "http://api.test", orgSlug: "acme", token: "t" },
      fetchImpl
    );
    await client.getAgentSettings("a1").catch(() => undefined);
    expect(sawHeader).toBeNull();
  });
});
