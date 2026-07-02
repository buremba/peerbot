import { describe, expect, mock, test } from "bun:test";
import {
  executePlan,
  locallyDeclaredConnectorKeys,
  pushProviderApiKeys,
  readBoundedBody,
  validateConnectorState,
} from "../apply-cmd.js";
import type { ApplyClient, RemoteConnectorDefinition } from "../client.js";
import type { DiffPlan, RemoteSnapshot } from "../diff.js";
import {
  normalizeConnectionConfigScope,
  validateConnectionAgainstConnector,
} from "../desired-state.js";
import type {
  DesiredAgent,
  DesiredConnection,
  DesiredState,
  ResolvedConnectorSchemas,
} from "../desired-state.js";

// Minimal DesiredState with just the connectors slice populated.
function stateWith(connectors: DesiredState["connectors"]): DesiredState {
  return {
    agents: [],
    prune: false,
    memorySchema: { entityTypes: [], relationshipTypes: [] },
    watchers: [],
    connectors,
    providers: [],
    requiredSecrets: [],
  };
}

function makeResponse(body: string): Response {
  // Use the real Web Response so it exposes a streaming `body`.
  return new Response(body, { headers: { "content-type": "text/plain" } });
}

describe("validateConnectionAgainstConnector — managedBy is not a connector option", () => {
  const strictSchemas: ResolvedConnectorSchemas = {
    optionsSchema: {
      type: "object",
      additionalProperties: false,
      properties: { region: { type: "string" } },
    },
    feedKeys: new Set<string>(),
    feedConfigSchemas: new Map(),
    authKinds: new Set<string>(["oauth_account"]),
  };

  test("a strict optionsSchema accepts a managedBy connection", () => {
    const connection: DesiredConnection = {
      slug: "spotify",
      connector: "spotify",
      // managedBy is Lobu metadata folded into config — it must be stripped
      // before option-schema validation or a strict schema rejects it.
      config: { managedBy: { org: "lobu-public" } },
      feeds: [],
      sourceFile: "lobu.config.ts",
    };
    expect(() =>
      validateConnectionAgainstConnector(connection, new Map(), strictSchemas)
    ).not.toThrow();
  });

  test("a genuinely unknown option still fails the strict schema", () => {
    const connection: DesiredConnection = {
      slug: "spotify",
      connector: "spotify",
      config: { bogusOption: true },
      feeds: [],
      sourceFile: "lobu.config.ts",
    };
    expect(() =>
      validateConnectionAgainstConnector(connection, new Map(), strictSchemas)
    ).toThrow();
  });
});

describe("normalizeConnectionConfigScope — feed-scoped keys demote to feeds", () => {
  // A connector whose `search_query`/`lookback_days` are feed-scoped (declared
  // on the `stories` feed), with one genuinely connection-scoped key (`region`).
  const schemas: ResolvedConnectorSchemas = {
    optionsSchema: {
      type: "object",
      properties: { region: { type: "string" } },
    },
    feedKeys: new Set<string>(["stories"]),
    feedConfigSchemas: new Map([
      [
        "stories",
        {
          type: "object",
          properties: {
            search_query: { type: "string" },
            lookback_days: { type: "integer" },
          },
        },
      ],
    ]),
    authKinds: new Set<string>(),
  };

  test("feed-scoped key on the connection is moved to the feed and removed from the connection", () => {
    const connection: DesiredConnection = {
      slug: "hn",
      connector: "hackernews",
      config: { search_query: "AI agents", lookback_days: 30 },
      feeds: [{ feedKey: "stories" }],
      sourceFile: "lobu.config.ts",
    };
    const demoted = normalizeConnectionConfigScope(connection, schemas);
    expect(demoted.sort()).toEqual(["lookback_days", "search_query"]);
    expect(connection.config).toBeUndefined();
    expect(connection.feeds[0]?.config).toEqual({
      search_query: "AI agents",
      lookback_days: 30,
    });
    // The normalized connection now passes server-mirrored validation.
    expect(() =>
      validateConnectionAgainstConnector(connection, new Map(), schemas)
    ).not.toThrow();
  });

  test("an explicit feed value wins over the demoted connection default", () => {
    const connection: DesiredConnection = {
      slug: "hn",
      connector: "hackernews",
      config: { search_query: "connection-level" },
      feeds: [{ feedKey: "stories", config: { search_query: "feed-level" } }],
      sourceFile: "lobu.config.ts",
    };
    normalizeConnectionConfigScope(connection, schemas);
    expect(connection.feeds[0]?.config).toEqual({ search_query: "feed-level" });
  });

  test("connection-scoped keys and managedBy stay on the connection", () => {
    const connection: DesiredConnection = {
      slug: "hn",
      connector: "hackernews",
      config: {
        region: "us",
        search_query: "AI agents",
        managedBy: { org: "lobu-public" },
      },
      feeds: [{ feedKey: "stories" }],
      sourceFile: "lobu.config.ts",
    };
    const demoted = normalizeConnectionConfigScope(connection, schemas);
    expect(demoted).toEqual(["search_query"]);
    expect(connection.config).toEqual({
      region: "us",
      managedBy: { org: "lobu-public" },
    });
    expect(connection.feeds[0]?.config).toEqual({ search_query: "AI agents" });
  });

  test("a clean connection (no feed-scoped keys) is left untouched", () => {
    const connection: DesiredConnection = {
      slug: "hn",
      connector: "hackernews",
      feeds: [{ feedKey: "stories", config: { search_query: "AI agents" } }],
      sourceFile: "lobu.config.ts",
    };
    const demoted = normalizeConnectionConfigScope(connection, schemas);
    expect(demoted).toEqual([]);
    expect(connection.config).toBeUndefined();
    expect(connection.feeds[0]?.config).toEqual({ search_query: "AI agents" });
  });
});

describe("readBoundedBody (#3 — bounded source_url fetch)", () => {
  test("reads a small body in full", async () => {
    const text = await readBoundedBody(
      makeResponse("hello world"),
      1024,
      () => {
        throw new Error("should not overflow");
      }
    );
    expect(text).toBe("hello world");
  });

  test("aborts + throws as soon as the running byte total exceeds the cap", async () => {
    // 4 KiB body, 1 KiB cap.
    const big = "x".repeat(4096);
    let overflowed = false;
    await expect(
      readBoundedBody(makeResponse(big), 1024, () => {
        overflowed = true;
        throw new Error("body exceeds the 1024-byte cap");
      })
    ).rejects.toThrow(/exceeds the 1024-byte cap/);
    expect(overflowed).toBe(true);
  });

  test("counts BYTES, not UTF-16 code units (multi-byte chars)", async () => {
    // 200 "€" chars = 600 UTF-8 bytes but only 200 UTF-16 code units.
    const euros = "€".repeat(200);
    await expect(
      readBoundedBody(makeResponse(euros), 400, () => {
        throw new Error("body exceeds the 400-byte cap");
      })
    ).rejects.toThrow(/exceeds the 400-byte cap/);
    // Same content fits under a 1 KiB cap.
    const ok = await readBoundedBody(makeResponse(euros), 1024, () => {
      throw new Error("should not overflow");
    });
    expect(ok).toBe(euros);
  });
});

describe("pushProviderApiKeys (#11 — provider keys pushed on a noop-only apply)", () => {
  function agentWithKeys(
    agentId: string,
    providerKeys: { providerId: string; value: string }[]
  ): DesiredAgent {
    return {
      metadata: { agentId, name: agentId },
      settings: {},
      platforms: [],
      providerKeys,
    };
  }

  test("pushes setProviderApiKey for every declared key (otherwise-noop agents)", async () => {
    const setProviderApiKey = mock(async () => {
      /* resolve void */
    });
    const client = { setProviderApiKey } as unknown as ApplyClient;
    const agents = [
      agentWithKeys("a1", [
        { providerId: "anthropic", value: "k-anthropic" },
        { providerId: "openai", value: "k-openai" },
      ]),
      agentWithKeys("a2", [{ providerId: "zai", value: "k-zai" }]),
    ];

    await pushProviderApiKeys(client, agents);

    expect(setProviderApiKey).toHaveBeenCalledTimes(3);
    expect(setProviderApiKey).toHaveBeenCalledWith(
      "a1",
      "anthropic",
      "k-anthropic"
    );
    expect(setProviderApiKey).toHaveBeenCalledWith("a1", "openai", "k-openai");
    expect(setProviderApiKey).toHaveBeenCalledWith("a2", "zai", "k-zai");
  });

  test("no-op when no agent declares a provider key", async () => {
    const setProviderApiKey = mock(async () => {
      /* resolve void */
    });
    const client = { setProviderApiKey } as unknown as ApplyClient;

    await pushProviderApiKeys(client, [agentWithKeys("a1", [])]);

    expect(setProviderApiKey).not.toHaveBeenCalled();
  });

  // Regression: provider keys target `/agents/<id>/providers/...`, so on a
  // FIRST apply the agent must be created (executePlan) BEFORE the key push, or
  // the server 404s ("Agent not found"). This models that constraint and proves
  // the helpers compose in the correct order.
  describe("ordering with a first-apply create plan", () => {
    function recordingClient(): {
      client: ApplyClient;
      order: string[];
    } {
      const createdAgents = new Set<string>();
      const order: string[] = [];
      const client = {
        async upsertAgent(meta: { agentId: string }) {
          createdAgents.add(meta.agentId);
          order.push(`upsertAgent:${meta.agentId}`);
        },
        async setProviderApiKey(agentId: string, providerId: string) {
          if (!createdAgents.has(agentId)) {
            // Mirror the server: the agent must exist first.
            throw new Error(`Agent not found: ${agentId}`);
          }
          order.push(`setProviderApiKey:${agentId}/${providerId}`);
        },
      } as unknown as ApplyClient;
      return { client, order };
    }

    const desiredAgent = agentWithKeys("new-agent", [
      { providerId: "anthropic", value: "k-anthropic" },
    ]);
    const state: DesiredState = {
      agents: [desiredAgent],
      prune: false,
      memorySchema: { entityTypes: [], relationshipTypes: [] },
      watchers: [],
      connectors: { definitions: [], authProfiles: [], connections: [] },
      requiredSecrets: [],
    };
    const plan: DiffPlan = {
      rows: [
        {
          kind: "agent",
          verb: "create",
          id: "new-agent",
          desired: desiredAgent.metadata,
        },
      ],
      counts: { create: 1, update: 0, noop: 0, drift: 0, delete: 0 },
      notes: [],
    };
    const remote = {
      agents: [],
      agentSettings: new Map(),
      platformsByAgent: new Map(),
      entityTypes: [],
      relationshipTypes: [],
      watchers: [],
      connectorDefinitions: [],
      authProfiles: [],
      connections: [],
      feedsByConnectionId: new Map(),
    } as unknown as RemoteSnapshot;

    test("executePlan THEN pushProviderApiKeys succeeds (agent exists first)", async () => {
      const { client, order } = recordingClient();
      await executePlan({ client, state, plan, remote }, []);
      await pushProviderApiKeys(client, state.agents);
      expect(order).toEqual([
        "upsertAgent:new-agent",
        "setProviderApiKey:new-agent/anthropic",
      ]);
    });

    test("the reverse order (keys before create) reproduces the 404", async () => {
      const { client } = recordingClient();
      // Negative control: pushing keys before executePlan is the bug pi caught.
      await expect(pushProviderApiKeys(client, state.agents)).rejects.toThrow(
        /Agent not found/
      );
    });
  });
});

describe("validateConnectorState — skip stale schema for locally-declared keys (#2)", () => {
  const localDef = {
    key: "myconn",
    sourcePath: "/proj/connectors/myconn.connector.ts",
    sourceCode: "export default class {}",
    sourceFile: "connectors/myconn.connector.ts",
  };
  const connectors: DesiredState["connectors"] = {
    definitions: [localDef],
    authProfiles: [],
    connections: [
      {
        slug: "c1",
        connector: "myconn",
        // valid only against the *new* schema (string `mode`); the stale remote
        // schema below requires `mode` to be a number.
        config: { mode: "fast" },
        feeds: [],
        sourceFile: "connectors/myconn.yaml",
      },
    ],
  };
  // The "stale" installed catalog: `myconn` exists with an old optionsSchema
  // that would reject `{ mode: "fast" }`.
  const staleCatalog: RemoteConnectorDefinition[] = [
    {
      key: "myconn",
      installed: true,
      installable: false,
      options_schema: {
        type: "object",
        properties: { mode: { type: "number" } },
        required: ["mode"],
        additionalProperties: false,
      },
    },
  ];

  test("does NOT validate config against the stale schema when the key is locally declared", () => {
    expect(() =>
      validateConnectorState(stateWith(connectors), staleCatalog, {
        skipSchemaForConnectorKeys: locallyDeclaredConnectorKeys(
          stateWith(connectors)
        ),
      })
    ).not.toThrow();
  });

  test("WOULD reject the config if the key were not locally declared (sanity check)", () => {
    expect(() =>
      validateConnectorState(stateWith(connectors), staleCatalog)
    ).toThrow(/connection "c1" config/);
  });

  test("structural checks still run for locally-declared connectors (bad auth-profile ref)", () => {
    const bad: DesiredState["connectors"] = {
      definitions: [localDef],
      authProfiles: [],
      connections: [
        {
          slug: "c2",
          connector: "myconn",
          authProfileSlug: "nope", // not declared anywhere
          feeds: [],
          sourceFile: "connectors/myconn.yaml",
        },
      ],
    };
    expect(() =>
      validateConnectorState(stateWith(bad), staleCatalog, {
        skipSchemaForConnectorKeys: locallyDeclaredConnectorKeys(
          stateWith(bad)
        ),
      })
    ).toThrow(/references auth profile "nope"/);
  });

  test("requireInstalled: errors when a referenced connector is not in the fresh catalog", () => {
    const connectors: DesiredState["connectors"] = {
      definitions: [],
      authProfiles: [],
      connections: [
        {
          slug: "c-typo",
          connector: "doesnt-exist",
          feeds: [],
          sourceFile: "connectors/x.yaml",
        },
      ],
    };
    expect(() =>
      validateConnectorState(stateWith(connectors), [], {
        requireInstalled: true,
      })
    ).toThrow(
      /connector "doesnt-exist" referenced by connection "c-typo" is not installed/
    );
  });

  test("requireInstalled: errors when a referenced connector is present but not installed", () => {
    const connectors: DesiredState["connectors"] = {
      definitions: [],
      authProfiles: [],
      connections: [
        {
          slug: "c1",
          connector: "catalog-only",
          feeds: [],
          sourceFile: "connectors/x.yaml",
        },
      ],
    };
    // present in the catalog but installable-not-installed (e.g. a bundled
    // connector that was never installed for the org).
    expect(() =>
      validateConnectorState(
        stateWith(connectors),
        [{ key: "catalog-only", installed: false, installable: true }],
        { requireInstalled: true }
      )
    ).toThrow(
      /connector "catalog-only" referenced by connection "c1" is not installed/
    );
  });

  test("requireInstalled: passes when the referenced connector is installed", () => {
    const connectors: DesiredState["connectors"] = {
      definitions: [],
      authProfiles: [
        {
          slug: "ap",
          connector: "myconn",
          kind: "env",
          credentials: { K: "v" },
          sourceFile: "connectors/x.yaml",
        },
      ],
      connections: [
        {
          slug: "c1",
          connector: "myconn",
          authProfileSlug: "ap",
          feeds: [],
          sourceFile: "connectors/x.yaml",
        },
      ],
    };
    expect(() =>
      validateConnectorState(
        stateWith(connectors),
        [
          {
            key: "myconn",
            installed: true,
            installable: false,
            auth_schema: { methods: [{ type: "env_keys" }] },
          },
        ],
        { requireInstalled: true }
      )
    ).not.toThrow();
  });
});

describe("validateConnectorState — feed-scoped key demotion is gated to the pre-diff pass", () => {
  const catalog: RemoteConnectorDefinition[] = [
    {
      key: "hn",
      installed: true,
      installable: false,
      feeds_schema: {
        stories: {
          configSchema: {
            type: "object",
            properties: { search_query: { type: "string" } },
          },
        },
      },
    },
  ];
  const makeState = () =>
    stateWith({
      definitions: [],
      authProfiles: [],
      connections: [
        {
          slug: "c1",
          connector: "hn",
          config: { search_query: "AI" },
          feeds: [{ feedKey: "stories" }],
          sourceFile: "lobu.config.ts",
        },
      ],
    });

  test("pre-diff pass demotes the feed-scoped key onto the feed and warns", () => {
    const state = makeState();
    const warnings = validateConnectorState(state, catalog);
    expect(warnings.some((w) => w.includes("search_query"))).toBe(true);
    const conn = state.connectors.connections[0];
    expect(conn?.config).toBeUndefined();
    expect(conn?.feeds[0]?.config).toEqual({ search_query: "AI" });
  });

  test("post-install pass (requireInstalled) does NOT demote — the plan is already computed", () => {
    const state = makeState();
    const warnings = validateConnectorState(state, catalog, {
      requireInstalled: true,
    });
    expect(warnings).toEqual([]);
    // Left as authored: mutating here wouldn't reach the already-built feed
    // rows, so we don't — a misauthored key fails loudly at the server instead.
    expect(state.connectors.connections[0]?.config).toEqual({
      search_query: "AI",
    });
  });
});
