import { describe, expect, mock, test } from "bun:test";
import { ApiError } from "../../../memory/_lib/errors.js";
import {
  executePlan,
  fetchRemoteSnapshot,
  locallyDeclaredConnectorKeys,
  pushProviderApiKeys,
  readBoundedBody,
  validateConnectorState,
} from "../apply-cmd.js";
import type { ApplyClient, RemoteConnectorDefinition } from "../client.js";
import type {
  DesiredAgent,
  DesiredConnection,
  DesiredState,
  ResolvedConnectorSchemas,
} from "../desired-state.js";
import {
  normalizeConnectionConfigScope,
  validateConnectionAgainstConnector,
} from "../desired-state.js";
import type { DiffPlan, RemoteSnapshot } from "../diff.js";

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

describe("validateConnectionAgainstConnector — chat capability", () => {
  const chatSchemas: ResolvedConnectorSchemas = {
    optionsSchema: {
      type: "object",
      "x-lobu-chat-platform": "slack",
      properties: { botToken: { type: "string" } },
      required: ["botToken"],
    },
    feedKeys: new Set<string>(),
    feedConfigSchemas: new Map(),
    authKinds: new Set<string>(["none"]),
  };

  function chatConnection(
    overrides: Partial<DesiredConnection> = {}
  ): DesiredConnection {
    return {
      slug: "team-slack",
      connector: "slack",
      config: { botToken: "xoxb-test" },
      feeds: [],
      sourceFile: "lobu.config.ts",
      ...overrides,
    };
  }

  test("accepts an explicitly declared BYO chat connection", () => {
    expect(() =>
      validateConnectionAgainstConnector(
        chatConnection({ credentialMode: "byo" }),
        new Map(),
        chatSchemas
      )
    ).not.toThrow();
  });

  test("rejects a chat connection that omits credentialMode", () => {
    expect(() =>
      validateConnectionAgainstConnector(
        chatConnection(),
        new Map(),
        chatSchemas
      )
    ).toThrow(/must declare credentialMode "byo"/);
  });

  test("rejects a declarative managed chat connection", () => {
    expect(() =>
      validateConnectionAgainstConnector(
        chatConnection({
          config: {
            botToken: "xoxb-test",
            managedBy: { org: "cloud" },
          },
        }),
        new Map(),
        chatSchemas
      )
    ).toThrow(/owned by the OAuth\/install flow/);
  });

  test("rejects BYO mode on a non-chat connector", () => {
    expect(() =>
      validateConnectionAgainstConnector(
        chatConnection({
          connector: "github",
          credentialMode: "byo",
        }),
        new Map(),
        {
          ...chatSchemas,
          optionsSchema: {
            type: "object",
            properties: { botToken: { type: "string" } },
          },
        }
      )
    ).toThrow(/does not declare the chat capability/);
  });
});

describe("executePlan — BYO chat connection dependencies", () => {
  test("uses the newly created chat connection id for a Behavior in the same apply", async () => {
    const connection: DesiredConnection = {
      slug: "team-slack",
      connector: "slack",
      credentialMode: "byo",
      config: { botToken: "xoxb-test" },
      feeds: [],
      sourceFile: "lobu.config.ts",
    };
    const watcher: DesiredState["watchers"][number] = {
      slug: "reply-in-support",
      agent: "triage",
      prompt: "Reply helpfully.",
      triggers: [
        {
          kind: "event",
          connector_key: "slack",
          connectionSlug: "team-slack",
          event_types: ["message.created"],
          execution: "turn",
          active_run: "queue",
          output: "reply_to_source",
        },
      ],
    };
    const state = stateWith({
      definitions: [],
      authProfiles: [],
      connections: [connection],
    });
    state.watchers = [watcher];
    const plan: DiffPlan = {
      rows: [
        {
          kind: "connection",
          verb: "create",
          id: connection.slug,
          desired: connection,
        },
        {
          kind: "watcher",
          verb: "create",
          id: watcher.slug,
          desired: watcher,
        },
      ],
      counts: { create: 2, update: 0, noop: 0, drift: 0, delete: 0 },
      notes: [],
    };
    const remote: RemoteSnapshot = {
      agents: [],
      agentSettings: new Map(),
      entityTypes: [],
      relationshipTypes: [],
      watchers: [],
      connectorDefinitions: [
        {
          key: "slack",
          installed: true,
          options_schema: {
            type: "object",
            "x-lobu-chat-platform": "slack",
            properties: { botToken: { type: "string" } },
            required: ["botToken"],
          },
        },
      ],
      authProfiles: [],
      connections: [],
      feedsByConnectionId: new Map(),
      inferenceProviders: [],
    };
    const applyChatConnection = mock(async () => ({
      id: 91,
      created: true,
      changed: true,
    }));
    const createBehavior = mock(async () => ({ behavior_id: "b-1" }));
    const client = {
      applyChatConnection,
      createBehavior,
    } as unknown as ApplyClient;

    await executePlan({ client, state, plan, remote }, []);

    expect(applyChatConnection).toHaveBeenCalledTimes(1);
    expect(createBehavior).toHaveBeenCalledTimes(1);
    expect(createBehavior.mock.calls[0]?.[0].triggers).toEqual([
      {
        kind: "event",
        connector_key: "slack",
        connection_id: 91,
        event_types: ["message.created"],
        execution: "turn",
        active_run: "queue",
        output: "reply_to_source",
      },
    ]);
  });
});

describe("executePlan — entity-type schema fidelity", () => {
  test("carries the live type's out-of-band metadata_schema keys into the upsert", async () => {
    const desired = {
      slug: "person",
      name: "Person",
      properties: {
        email: { type: "string" },
        handle: { type: "string" },
      },
      required: ["email"],
    };
    const state = stateWith({
      definitions: [],
      authProfiles: [],
      connections: [],
    });
    state.memorySchema.entityTypes = [desired];
    const plan: DiffPlan = {
      rows: [
        {
          kind: "entity-type",
          verb: "update",
          id: desired.slug,
          desired,
          changedFields: ["properties"],
        },
      ],
      counts: { create: 0, update: 1, noop: 0, drift: 0, delete: 0 },
      notes: [],
    };
    const schemaExtras = {
      "x-lobu-resolution": {
        rules: [
          { fields: ["email"], normalizer: "email", onMatch: "auto_merge" },
        ],
      },
    };
    const ownedRemote = {
      slug: "person",
      organization_id: "org_acme",
      properties: { email: { type: "string" } },
      required: ["email"],
      schemaExtras,
    };
    // computeDiff matches against the ORG-OWNED types only, and stores that
    // match on the row. The raw snapshot also carries public types from OTHER
    // orgs, returned AFTER the org's own rows — so a slug→row map rebuilt here
    // would pick this decoy up and push another org's resolution rules (or, if
    // it had none, erase the owned ones). Assert the row's match wins.
    const foreignPublic = {
      slug: "person",
      organization_id: "org_public_catalog",
      schemaExtras: { "x-lobu-resolution": { rules: [] } },
    };
    const rowZero = plan.rows[0];
    if (rowZero?.kind === "entity-type") rowZero.remote = ownedRemote;
    const remote: RemoteSnapshot = {
      agents: [],
      agentSettings: new Map(),
      entityTypes: [ownedRemote, foreignPublic],
      relationshipTypes: [],
      watchers: [],
      connectorDefinitions: [],
      authProfiles: [],
      connections: [],
      feedsByConnectionId: new Map(),
      inferenceProviders: [],
    };
    const upsertEntityType = mock(async () => ({ updated: true }));
    const client = { upsertEntityType } as unknown as ApplyClient;

    await executePlan({ client, state, plan, remote }, []);

    expect(upsertEntityType).toHaveBeenCalledTimes(1);
    expect(upsertEntityType.mock.calls[0]?.[1]).toEqual(schemaExtras);
  });

  test("maps three-way properties.<key> clears to a whole-properties clearFacet when config omits properties", async () => {
    // Config under prune drops the entire properties object; three-way
    // reports per-key clears as properties.<key>. upsertEntityType only
    // honors the whole-facet "properties" clearFacet for that case.
    const desired = {
      slug: "task",
      name: "Task",
      // properties intentionally omitted
    };
    const state = stateWith({
      definitions: [],
      authProfiles: [],
      connections: [],
    });
    state.memorySchema.entityTypes = [desired as any];
    const remoteType = {
      slug: "task",
      organization_id: "org_acme",
      properties: { status: { type: "string" }, assignee: { type: "string" } },
      required: ["status"],
    };
    const plan: DiffPlan = {
      rows: [
        {
          kind: "entity-type",
          verb: "update",
          id: "task",
          desired: desired as any,
          remote: remoteType as any,
          changedFields: ["properties.status", "properties.assignee"],
        },
      ],
      counts: { create: 0, update: 1, noop: 0, drift: 0, delete: 0 },
      notes: [],
    };
    const remote: RemoteSnapshot = {
      agents: [],
      agentSettings: new Map(),
      entityTypes: [remoteType as any],
      relationshipTypes: [],
      watchers: [],
      connectorDefinitions: [],
      authProfiles: [],
      connections: [],
      feedsByConnectionId: new Map(),
      inferenceProviders: [],
    };
    const upsertEntityType = mock(async () => ({ updated: true }));
    const client = { upsertEntityType } as unknown as ApplyClient;

    await executePlan({ client, state, plan, remote }, []);

    expect(upsertEntityType).toHaveBeenCalledTimes(1);
    const clearFacets = upsertEntityType.mock.calls[0]?.[3] as Set<string>;
    expect(clearFacets.has("properties")).toBe(true);
  });
});

describe("fetchRemoteSnapshot — view-template fetch is org-scoped", () => {
  test("does not fetch a template for a foreign public type whose slug is also config-declared", async () => {
    const templateCalls: string[] = [];
    const client = {
      listAgents: async () => [],
      listEntityTypes: async () => [
        // Foreign public type (owned by another org) — same slug as a config type.
        { slug: "company", organization_id: "org-market" },
        // Org-owned type with a declared template.
        { slug: "task", organization_id: "org-acme" },
      ],
      listRelationshipTypes: async () => [],
      listBehaviors: async () => [],
      listConnectors: async () => [],
      listAuthProfiles: async () => [],
      listConnections: async () => [],
      listInferenceProviders: async () => [],
      getEntityTypeViewTemplate: async (slug: string) => {
        templateCalls.push(slug);
        return { root: { type: "box" } };
      },
    } as unknown as ApplyClient;

    const state: DesiredState = {
      agents: [],
      prune: true,
      memorySchema: {
        entityTypes: [
          { slug: "company", viewTemplate: { root: { type: "box" } } },
          { slug: "task", viewTemplate: { root: { type: "box" } } },
        ],
        relationshipTypes: [],
      },
      watchers: [],
      connectors: { definitions: [], authProfiles: [], connections: [] },
      providers: [],
      requiredSecrets: [],
    };

    const remote = await fetchRemoteSnapshot(
      client,
      state,
      undefined,
      true,
      "org-acme"
    );
    expect(templateCalls).toEqual(["task"]);
    expect(
      remote.entityTypes.find((e) => e.slug === "task")?.viewTemplate
    ).toBeDefined();
    // The foreign type's slug is still surfaced for visibility, but its template
    // was never fetched (the org-local copy is absent/deleted and would 404).
    expect(
      remote.entityTypes.find((e) => e.slug === "company")?.viewTemplate
    ).toBeUndefined();
  });
});

describe("executePlan — atomic Behavior triggers+prompt update", () => {
  test("sends simultaneous prompt+trigger drift through createBehaviorVersion only", async () => {
    const desired = {
      slug: "digest",
      agent: "triage",
      prompt: "Now scheduled digest instructions.",
      triggers: [{ kind: "schedule" as const, cron: "0 9 * * *" }],
    };
    const state = stateWith({
      definitions: [],
      authProfiles: [],
      connections: [],
    });
    state.watchers = [desired];
    const plan: DiffPlan = {
      rows: [
        {
          kind: "watcher",
          verb: "update",
          id: desired.slug,
          desired,
          changedFields: ["triggers", "prompt"],
          versionBoundFields: ["prompt"],
        },
      ],
      counts: { create: 0, update: 1, noop: 0, drift: 0, delete: 0 },
      notes: [],
    };
    const remote: RemoteSnapshot = {
      agents: [],
      agentSettings: new Map(),
      entityTypes: [],
      relationshipTypes: [],
      watchers: [
        {
          slug: "digest",
          behavior_id: "42",
          agent_id: "triage",
          prompt: "",
          triggers: [
            {
              kind: "event",
              connector_key: "slack",
              event_types: ["message.created"],
              execution: "turn",
            },
          ],
        },
      ],
      connectorDefinitions: [],
      authProfiles: [],
      connections: [],
      feedsByConnectionId: new Map(),
      inferenceProviders: [],
    };
    const updateBehavior = mock(async () => ({}));
    const createBehaviorVersion = mock(async () => ({ version: 2 }));
    const client = {
      updateBehavior,
      createBehaviorVersion,
    } as unknown as ApplyClient;

    await executePlan({ client, state, plan, remote }, []);

    // Must not split triggers onto update (would fail the instruction rule
    // against the empty current prompt before create_version lands).
    expect(updateBehavior).not.toHaveBeenCalled();
    expect(createBehaviorVersion).toHaveBeenCalledTimes(1);
    expect(createBehaviorVersion.mock.calls[0]?.[0]).toMatchObject({
      behavior_id: "42",
      prompt: "Now scheduled digest instructions.",
      triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
    });
  });

  test("sends simultaneous skills+trigger drift through createBehaviorVersion only", async () => {
    const desired = {
      slug: "skills-digest",
      agent: "triage",
      prompt: "",
      skillSnapshots: [
        { name: "digest-runbook", content: "Produce the scheduled digest." },
      ],
      triggers: [{ kind: "schedule" as const, cron: "0 9 * * *" }],
    };
    const state = stateWith({
      definitions: [],
      authProfiles: [],
      connections: [],
    });
    state.watchers = [desired];
    const plan: DiffPlan = {
      rows: [
        {
          kind: "watcher",
          verb: "update",
          id: desired.slug,
          desired,
          changedFields: ["triggers", "skills"],
          versionBoundFields: ["skills"],
        },
      ],
      counts: { create: 0, update: 1, noop: 0, drift: 0, delete: 0 },
      notes: [],
    };
    const remote: RemoteSnapshot = {
      agents: [],
      agentSettings: new Map(),
      entityTypes: [],
      relationshipTypes: [],
      watchers: [
        {
          slug: desired.slug,
          behavior_id: "43",
          agent_id: "triage",
          prompt: "",
          skills: null,
          triggers: [
            {
              kind: "event",
              connector_key: "slack",
              event_types: ["message.created"],
              execution: "turn",
            },
          ],
        },
      ],
      connectorDefinitions: [],
      authProfiles: [],
      connections: [],
      feedsByConnectionId: new Map(),
      inferenceProviders: [],
    };
    const updateBehavior = mock(async () => ({}));
    const createBehaviorVersion = mock(async () => ({ version: 2 }));
    const client = {
      updateBehavior,
      createBehaviorVersion,
    } as unknown as ApplyClient;

    await executePlan({ client, state, plan, remote }, []);

    expect(updateBehavior).not.toHaveBeenCalled();
    expect(createBehaviorVersion).toHaveBeenCalledTimes(1);
    expect(createBehaviorVersion.mock.calls[0]?.[0]).toMatchObject({
      behavior_id: "43",
      skills: desired.skillSnapshots,
      triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
    });
  });

  test("sends outputs null when the declaration was removed", async () => {
    const desired = {
      slug: "canvas-only",
      agent: "triage",
      prompt: "Keep the result on Canvas.",
      triggers: [{ kind: "schedule" as const, cron: "0 9 * * *" }],
    };
    const state = stateWith({
      definitions: [],
      authProfiles: [],
      connections: [],
    });
    state.watchers = [desired];
    const plan: DiffPlan = {
      rows: [
        {
          kind: "watcher",
          verb: "update",
          id: desired.slug,
          desired,
          changedFields: ["outputs"],
          versionBoundFields: ["outputs"],
        },
      ],
      counts: { create: 0, update: 1, noop: 0, drift: 0, delete: 0 },
      notes: [],
    };
    const remote: RemoteSnapshot = {
      agents: [],
      agentSettings: new Map(),
      entityTypes: [],
      relationshipTypes: [],
      watchers: [
        {
          slug: desired.slug,
          behavior_id: "44",
          agent_id: "triage",
          prompt: desired.prompt,
          triggers: desired.triggers,
          outputs: { items: { entity: "company", key: ["name"] } },
        },
      ],
      connectorDefinitions: [],
      authProfiles: [],
      connections: [],
      feedsByConnectionId: new Map(),
      inferenceProviders: [],
    };
    const createBehaviorVersion = mock(async () => ({ version: 2 }));
    const client = {
      updateBehavior: mock(async () => ({})),
      createBehaviorVersion,
    } as unknown as ApplyClient;

    await executePlan({ client, state, plan, remote }, []);

    expect(createBehaviorVersion).toHaveBeenCalledTimes(1);
    expect(createBehaviorVersion.mock.calls[0]?.[0]).toMatchObject({
      behavior_id: "44",
      outputs: null,
    });
  });

  test("clears outputs and changes to turn execution in one version write", async () => {
    const desired = {
      slug: "turn-only",
      agent: "triage",
      prompt: "Reply directly without durable outputs.",
      triggers: [
        {
          kind: "event" as const,
          connector_key: "slack",
          event_types: ["message.created"],
          execution: "turn" as const,
        },
      ],
    };
    const state = stateWith({
      definitions: [],
      authProfiles: [],
      connections: [],
    });
    state.watchers = [desired];
    const plan: DiffPlan = {
      rows: [
        {
          kind: "watcher",
          verb: "update",
          id: desired.slug,
          desired,
          changedFields: ["triggers", "outputs"],
          versionBoundFields: ["outputs"],
        },
      ],
      counts: { create: 0, update: 1, noop: 0, drift: 0, delete: 0 },
      notes: [],
    };
    const remote: RemoteSnapshot = {
      agents: [],
      agentSettings: new Map(),
      entityTypes: [],
      relationshipTypes: [],
      watchers: [
        {
          slug: desired.slug,
          behavior_id: "45",
          agent_id: "triage",
          prompt: desired.prompt,
          triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
          outputs: { items: { entity: "company", key: ["name"] } },
        },
      ],
      connectorDefinitions: [],
      authProfiles: [],
      connections: [],
      feedsByConnectionId: new Map(),
      inferenceProviders: [],
    };
    const updateBehavior = mock(async () => {
      throw new ApiError("turn execution cannot retain durable outputs");
    });
    const createBehaviorVersion = mock(async () => ({ version: 2 }));
    const client = {
      updateBehavior,
      createBehaviorVersion,
    } as unknown as ApplyClient;

    await executePlan({ client, state, plan, remote }, []);

    expect(updateBehavior).not.toHaveBeenCalled();
    expect(createBehaviorVersion).toHaveBeenCalledTimes(1);
    expect(createBehaviorVersion.mock.calls[0]?.[0]).toMatchObject({
      behavior_id: "45",
      outputs: null,
      triggers: desired.triggers,
    });
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
      providerKeys,
    };
  }

  test("dedupes by provider and rotates the org inference-provider key", async () => {
    const rotateInferenceProviderKey = mock(async () => {
      /* resolve void */
    });
    const createInferenceProvider = mock(async () => ({}));
    const client = {
      rotateInferenceProviderKey,
      createInferenceProvider,
    } as unknown as ApplyClient;
    const agents = [
      agentWithKeys("a1", [
        { providerId: "anthropic", value: "k-anthropic" },
        { providerId: "openai", value: "k-openai" },
      ]),
      // Same provider on a second agent: the key is ORG-scoped, so this is
      // one push (last declaration wins — the previous per-agent PUTs
      // overwrote the same org row, so last-wins was already the semantics).
      agentWithKeys("a2", [
        { providerId: "zai", value: "k-zai" },
        { providerId: "anthropic", value: "k-anthropic-2" },
      ]),
    ];

    await pushProviderApiKeys(client, agents);

    expect(rotateInferenceProviderKey).toHaveBeenCalledTimes(3);
    expect(rotateInferenceProviderKey).toHaveBeenCalledWith(
      "anthropic",
      "k-anthropic-2"
    );
    expect(rotateInferenceProviderKey).toHaveBeenCalledWith(
      "openai",
      "k-openai"
    );
    expect(rotateInferenceProviderKey).toHaveBeenCalledWith("zai", "k-zai");
    expect(createInferenceProvider).not.toHaveBeenCalled();
  });

  test("creates the org provider row when rotate 404s (no row yet)", async () => {
    const rotateInferenceProviderKey = mock(async () => {
      throw new ApiError("PUT .../key failed: Provider not found", 404);
    });
    const createInferenceProvider = mock(async () => ({}));
    const client = {
      rotateInferenceProviderKey,
      createInferenceProvider,
    } as unknown as ApplyClient;

    await pushProviderApiKeys(client, [
      agentWithKeys("a1", [{ providerId: "anthropic", value: "k-1" }]),
    ]);

    expect(createInferenceProvider).toHaveBeenCalledTimes(1);
    expect(createInferenceProvider).toHaveBeenCalledWith({
      slug: "anthropic",
      kind: "anthropic",
      apiKey: "k-1",
    });
  });

  test("non-404 rotate failures propagate (no create fallback)", async () => {
    const rotateInferenceProviderKey = mock(async () => {
      throw new ApiError("PUT .../key failed: boom", 500);
    });
    const createInferenceProvider = mock(async () => ({}));
    const client = {
      rotateInferenceProviderKey,
      createInferenceProvider,
    } as unknown as ApplyClient;

    await expect(
      pushProviderApiKeys(client, [
        agentWithKeys("a1", [{ providerId: "anthropic", value: "k-1" }]),
      ])
    ).rejects.toThrow(/boom/);
    expect(createInferenceProvider).not.toHaveBeenCalled();
  });

  test("no-op when no agent declares a provider key", async () => {
    const rotateInferenceProviderKey = mock(async () => {
      /* resolve void */
    });
    const client = { rotateInferenceProviderKey } as unknown as ApplyClient;

    await pushProviderApiKeys(client, [agentWithKeys("a1", [])]);

    expect(rotateInferenceProviderKey).not.toHaveBeenCalled();
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
