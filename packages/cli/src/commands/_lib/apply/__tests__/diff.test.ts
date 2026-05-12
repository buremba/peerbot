import { describe, expect, test } from "bun:test";
import chalk from "chalk";
import type { AgentSettings } from "@lobu/core";
import { computeDiff, type RemoteSnapshot } from "../diff.js";
import type { DesiredAgent, DesiredState } from "../desired-state.js";
import { renderPlan, renderSummary } from "../render.js";

// Force chalk to render plain text in snapshots regardless of TTY detection.
// `chalk.level = 0` strips colors so snapshot diffs aren't TTY-dependent.
chalk.level = 0;

function buildDesiredAgent(
  agentId: string,
  overrides: Partial<DesiredAgent> = {}
): DesiredAgent {
  return {
    metadata: { agentId, name: agentId, description: undefined },
    settings: {},
    platforms: [],
    ...overrides,
  };
}

function buildState(
  agents: DesiredAgent[],
  overrides: Partial<DesiredState> = {}
): DesiredState {
  return {
    agents,
    memorySchema: { entityTypes: [], relationshipTypes: [] },
    watchers: [],
    connectors: { definitions: [], authProfiles: [], connections: [] },
    requiredSecrets: [],
    ...overrides,
  };
}

function emptyRemote(): RemoteSnapshot {
  return {
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
  };
}

describe("apply diff — agents", () => {
  test("create from empty remote", () => {
    const desired = buildState([
      buildDesiredAgent("triage", {
        metadata: {
          agentId: "triage",
          name: "Triage",
          description: "Triage bot",
        },
      }),
    ]);
    const plan = computeDiff(desired, emptyRemote());

    expect(plan.counts).toEqual({ create: 2, update: 0, noop: 0, drift: 0 });
    expect(renderPlan(plan)).toMatchSnapshot();
  });

  test("noop when remote matches desired", () => {
    const desired = buildState([
      buildDesiredAgent("triage", {
        metadata: { agentId: "triage", name: "Triage" },
      }),
    ]);
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "triage", name: "Triage" }],
      agentSettings: new Map([["triage", null]]),
      platformsByAgent: new Map([["triage", []]]),
    };
    const plan = computeDiff(desired, remote);
    expect(plan.counts.noop).toBeGreaterThan(0);
    expect(plan.counts.create).toBe(0);
    expect(plan.counts.update).toBe(0);
    expect(renderPlan(plan)).toMatchSnapshot();
  });

  test("update when name differs", () => {
    const desired = buildState([
      buildDesiredAgent("triage", {
        metadata: { agentId: "triage", name: "Renamed" },
      }),
    ]);
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "triage", name: "Original" }],
      agentSettings: new Map([["triage", null]]),
      platformsByAgent: new Map([["triage", []]]),
    };
    const plan = computeDiff(desired, remote);
    expect(plan.counts.update).toBeGreaterThan(0);
    expect(renderPlan(plan)).toMatchSnapshot();
  });

  test("drift when remote has agent not in desired", () => {
    const desired = buildState([]);
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "stale", name: "Stale Agent" }],
    };
    const plan = computeDiff(desired, remote);
    expect(plan.counts.drift).toBe(1);
    expect(renderPlan(plan)).toMatchSnapshot();
  });
});

describe("apply diff — settings", () => {
  test("update on networkConfig change", () => {
    const desired = buildState([
      buildDesiredAgent("triage", {
        metadata: { agentId: "triage", name: "Triage" },
        settings: {
          networkConfig: { allowedDomains: ["github.com"] },
        },
      }),
    ]);
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "triage", name: "Triage" }],
      agentSettings: new Map<string, AgentSettings | null>([
        [
          "triage",
          {
            networkConfig: { allowedDomains: ["pypi.org"] },
            updatedAt: 0,
          },
        ],
      ]),
      platformsByAgent: new Map([["triage", []]]),
    };
    const plan = computeDiff(desired, remote);
    const settingsRow = plan.rows.find((r) => r.kind === "settings");
    expect(settingsRow?.verb).toBe("update");
    if (settingsRow?.kind === "settings") {
      expect(settingsRow.changedFields).toContain("networkConfig");
    }
    expect(renderPlan(plan)).toMatchSnapshot();
  });

  test("updates when provider declarations change but ignores installedAt churn", () => {
    const desired = buildState([
      buildDesiredAgent("triage", {
        metadata: { agentId: "triage", name: "Triage" },
        settings: {
          installedProviders: [
            { providerId: "anthropic", installedAt: 200 },
            { providerId: "openai", installedAt: 200 },
          ],
        },
      }),
    ]);
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "triage", name: "Triage" }],
      agentSettings: new Map<string, AgentSettings | null>([
        [
          "triage",
          {
            installedProviders: [{ providerId: "anthropic", installedAt: 100 }],
            updatedAt: 0,
          },
        ],
      ]),
      platformsByAgent: new Map([["triage", []]]),
    };
    const plan = computeDiff(desired, remote);
    const settingsRow = plan.rows.find((r) => r.kind === "settings");
    expect(settingsRow?.verb).toBe("update");
    if (settingsRow?.kind === "settings") {
      expect(settingsRow.changedFields).toContain("installedProviders");
    }

    const unchanged = computeDiff(desired, {
      ...remote,
      agentSettings: new Map<string, AgentSettings | null>([
        [
          "triage",
          {
            installedProviders: [
              { providerId: "anthropic", installedAt: 1 },
              { providerId: "openai", installedAt: 2 },
            ],
            updatedAt: 0,
          },
        ],
      ]),
    });
    const unchangedSettingsRow = unchanged.rows.find(
      (r) => r.kind === "settings"
    );
    expect(unchangedSettingsRow?.verb).toBe("noop");
  });
});

describe("apply diff — platforms", () => {
  test("create on empty remote", () => {
    const desired = buildState([
      buildDesiredAgent("triage", {
        metadata: { agentId: "triage", name: "Triage" },
        platforms: [
          {
            stableId: "triage-telegram",
            type: "telegram",
            config: { botToken: "abc" },
          },
        ],
      }),
    ]);
    const plan = computeDiff(desired, emptyRemote());
    const platformRow = plan.rows.find((r) => r.kind === "platform");
    expect(platformRow?.verb).toBe("create");
    expect(renderPlan(plan)).toMatchSnapshot();
  });

  test("update with willRestart when config changes", () => {
    const desired = buildState([
      buildDesiredAgent("triage", {
        metadata: { agentId: "triage", name: "Triage" },
        platforms: [
          {
            stableId: "triage-telegram",
            type: "telegram",
            config: { botToken: "new" },
          },
        ],
      }),
    ]);
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "triage", name: "Triage" }],
      agentSettings: new Map<string, AgentSettings | null>([["triage", null]]),
      platformsByAgent: new Map([
        [
          "triage",
          [
            {
              id: "triage-telegram",
              platform: "telegram",
              config: { botToken: "old" },
            },
          ],
        ],
      ]),
    };
    const plan = computeDiff(desired, remote);
    const platformRow = plan.rows.find((r) => r.kind === "platform");
    expect(platformRow?.verb).toBe("update");
    if (platformRow?.kind === "platform") {
      expect(platformRow.willRestart).toBe(true);
    }
    expect(renderPlan(plan)).toMatchSnapshot();
  });
});

describe("apply diff — memory schema", () => {
  test("creates entity + relationship types", () => {
    const desired: DesiredState = {
      agents: [],
      memorySchema: {
        entityTypes: [{ slug: "company", name: "Company", required: ["name"] }],
        relationshipTypes: [
          {
            slug: "works_at",
            name: "Works At",
            rules: [{ source: "person", target: "company" }],
          },
        ],
      },
      watchers: [],
      requiredSecrets: [],
    };
    const plan = computeDiff(desired, emptyRemote());
    expect(plan.counts.create).toBe(2);
    expect(renderPlan(plan)).toMatchSnapshot();
  });

  test("noop when remote matches", () => {
    const desired: DesiredState = {
      agents: [],
      memorySchema: {
        entityTypes: [{ slug: "company", name: "Company" }],
        relationshipTypes: [],
      },
      watchers: [],
      requiredSecrets: [],
    };
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      entityTypes: [{ slug: "company", name: "Company" }],
    };
    const plan = computeDiff(desired, remote);
    expect(plan.counts.noop).toBe(1);
    expect(plan.counts.update).toBe(0);
  });
});

describe("apply diff — empty container preservation", () => {
  // Bug fix: previously canonical() collapsed [] and {} to null, which
  // meant clearing a remote allowlist by setting it to [] silently
  // round-tripped as a noop instead of an update.
  test("clearing networkConfig.allowedDomains from non-empty to [] is an update", () => {
    const desired = buildState([
      buildDesiredAgent("triage", {
        metadata: { agentId: "triage", name: "Triage" },
        settings: {
          networkConfig: { allowedDomains: [] },
        },
      }),
    ]);
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "triage", name: "Triage" }],
      agentSettings: new Map<string, AgentSettings | null>([
        [
          "triage",
          {
            networkConfig: { allowedDomains: ["foo.com"] },
            updatedAt: 0,
          },
        ],
      ]),
      platformsByAgent: new Map([["triage", []]]),
    };
    const plan = computeDiff(desired, remote);
    const settingsRow = plan.rows.find((r) => r.kind === "settings");
    expect(settingsRow?.verb).toBe("update");
    if (settingsRow?.kind === "settings") {
      expect(settingsRow.changedFields).toContain("networkConfig");
    }
  });

  test("[] is not equal to null (preserved as distinct values)", () => {
    // When desired sets allowedDomains: [] and remote has the field
    // missing entirely, the diff should still treat them as equivalent
    // for the case where remote literally doesn't have the field — but
    // [] vs the explicit array ["foo"] must differ.
    const desiredEmpty = buildState([
      buildDesiredAgent("triage", {
        metadata: { agentId: "triage", name: "Triage" },
        settings: {
          networkConfig: { allowedDomains: [] },
        },
      }),
    ]);
    const remoteWithItems: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "triage", name: "Triage" }],
      agentSettings: new Map<string, AgentSettings | null>([
        [
          "triage",
          {
            networkConfig: { allowedDomains: ["x.com"] },
            updatedAt: 0,
          },
        ],
      ]),
      platformsByAgent: new Map([["triage", []]]),
    };
    const plan = computeDiff(desiredEmpty, remoteWithItems);
    expect(plan.counts.update).toBeGreaterThan(0);
  });

  test("{} is not equal to populated object", () => {
    // empty config object vs populated config object must show as drift/update
    const desired = buildState([
      buildDesiredAgent("triage", {
        metadata: { agentId: "triage", name: "Triage" },
        platforms: [
          {
            stableId: "triage-telegram",
            type: "telegram",
            config: {},
          },
        ],
      }),
    ]);
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "triage", name: "Triage" }],
      agentSettings: new Map<string, AgentSettings | null>([["triage", null]]),
      platformsByAgent: new Map([
        [
          "triage",
          [
            {
              id: "triage-telegram",
              platform: "telegram",
              config: { botToken: "abc" },
            },
          ],
        ],
      ]),
    };
    const plan = computeDiff(desired, remote);
    const platformRow = plan.rows.find((r) => r.kind === "platform");
    expect(platformRow?.verb).toBe("update");
  });
});

describe("apply diff — watchers", () => {
  const desiredWatcher = {
    slug: "weekly-digest",
    name: "Weekly digest",
    prompt: "Produce a digest.",
    extractionSchema: { type: "object" as const },
    schedule: "0 9 * * 1",
  };

  test("create when watcher missing remotely", () => {
    const desired = buildState([], { watchers: [desiredWatcher] });
    const plan = computeDiff(desired, emptyRemote());
    const row = plan.rows.find((r) => r.kind === "watcher");
    expect(row?.verb).toBe("create");
    expect(row?.id).toBe("weekly-digest");
  });

  test("noop when watcher already exists remotely", () => {
    const desired = buildState([], { watchers: [desiredWatcher] });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      watchers: [{ slug: "weekly-digest", name: "Weekly digest" }],
    };
    const plan = computeDiff(desired, remote);
    const row = plan.rows.find((r) => r.kind === "watcher");
    expect(row?.verb).toBe("noop");
    expect(plan.counts.create).toBe(0);
  });

  test("drift when remote watcher not declared in models", () => {
    const desired = buildState([], { watchers: [] });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      watchers: [{ slug: "orphan-watcher" }],
    };
    const plan = computeDiff(desired, remote);
    const row = plan.rows.find((r) => r.kind === "watcher");
    expect(row?.verb).toBe("drift");
    expect(plan.counts.drift).toBe(1);
  });
});

describe("renderSummary", () => {
  test("renders zero-row plan", () => {
    const desired = buildState([]);
    const plan = computeDiff(desired, emptyRemote());
    expect(renderSummary(plan)).toMatchSnapshot();
  });
});

describe("apply diff — connectors", () => {
  const builtinConnectorDef = {
    key: "hackernews",
    name: "Hacker News",
    installed: false,
    installable: true,
  };

  function connectorState() {
    return buildState([], {
      connectors: {
        definitions: [
          {
            key: "acme",
            sourcePath: "/proj/connectors/acme.connector.ts",
            sourceCode: "export default class {}",
            sourceFile: "connectors/acme.connector.ts",
          },
        ],
        authProfiles: [
          {
            slug: "hn-token",
            connector: "hackernews",
            kind: "env" as const,
            name: "HN token",
            credentials: { HN_TOKEN: "$HN_TOKEN" },
            sourceFile: "connectors/hackernews.yaml",
          },
          {
            slug: "x-account",
            connector: "x",
            kind: "oauth_account" as const,
            sourceFile: "connectors/x.yaml",
          },
        ],
        connections: [
          {
            slug: "hn-frontpage",
            connector: "hackernews",
            name: "HN front page",
            authProfileSlug: "hn-token",
            feeds: [{ feedKey: "stories", schedule: "0 * * * *" }],
            sourceFile: "connectors/hackernews.yaml",
          },
        ],
      },
    });
  }

  test("create verbs for new connector def, auth profile, connection, feed", () => {
    const plan = computeDiff(connectorState(), {
      ...emptyRemote(),
      connectorDefinitions: [builtinConnectorDef],
    });
    const def = plan.rows.find((r) => r.kind === "connector-definition");
    expect(def?.verb).toBe("create");
    const authEnv = plan.rows.find(
      (r) => r.kind === "auth-profile" && r.id === "hn-token"
    );
    expect(authEnv?.verb).toBe("create");
    const authOauth = plan.rows.find(
      (r) => r.kind === "auth-profile" && r.id === "x-account"
    );
    expect(authOauth?.verb).toBe("create");
    expect(
      authOauth && "needsAuth" in authOauth ? authOauth.needsAuth : undefined
    ).toBe(true);
    const conn = plan.rows.find((r) => r.kind === "connection");
    expect(conn?.verb).toBe("create");
    const feed = plan.rows.find((r) => r.kind === "feed");
    expect(feed?.verb).toBe("create");
    expect(feed?.id).toBe("hn-frontpage/stories");
  });

  test("noop when connection + feed already match remotely", () => {
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      connectorDefinitions: [builtinConnectorDef],
      authProfiles: [
        {
          slug: "hn-token",
          display_name: "HN token",
          connector_key: "hackernews",
          profile_kind: "env",
          status: "active",
        },
        {
          slug: "x-account",
          connector_key: "x",
          profile_kind: "oauth_account",
          status: "active",
        },
      ],
      connections: [
        {
          id: 7,
          slug: "hn-frontpage",
          connector_key: "hackernews",
          display_name: "HN front page",
          status: "active",
          auth_profile_slug: "hn-token",
          app_auth_profile_slug: null,
          config: {},
        },
      ],
      feedsByConnectionId: new Map([
        [
          7,
          [
            {
              id: 11,
              connection_id: 7,
              feed_key: "stories",
              status: "active",
              schedule: "0 * * * *",
              config: {},
            },
          ],
        ],
      ]),
    };
    const plan = computeDiff(connectorState(), remote);
    expect(plan.rows.find((r) => r.kind === "connection")?.verb).toBe("noop");
    expect(plan.rows.find((r) => r.kind === "feed")?.verb).toBe("noop");
    expect(
      plan.rows.find((r) => r.kind === "auth-profile" && r.id === "x-account")
        ?.verb
    ).toBe("noop");
  });

  test("update when feed schedule changes; needs-auth when oauth profile inactive", () => {
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      connectorDefinitions: [builtinConnectorDef],
      authProfiles: [
        {
          slug: "hn-token",
          display_name: "HN token",
          connector_key: "hackernews",
          profile_kind: "env",
          status: "active",
        },
        {
          slug: "x-account",
          connector_key: "x",
          profile_kind: "oauth_account",
          status: "pending_auth",
        },
      ],
      connections: [
        {
          id: 7,
          slug: "hn-frontpage",
          connector_key: "hackernews",
          display_name: "HN front page",
          status: "active",
          auth_profile_slug: "hn-token",
          app_auth_profile_slug: null,
          config: {},
        },
      ],
      feedsByConnectionId: new Map([
        [
          7,
          [
            {
              id: 11,
              connection_id: 7,
              feed_key: "stories",
              status: "active",
              schedule: "0 0 * * *",
              config: {},
            },
          ],
        ],
      ]),
    };
    const plan = computeDiff(connectorState(), remote);
    const feed = plan.rows.find((r) => r.kind === "feed");
    expect(feed?.verb).toBe("update");
    expect(feed && "changedFields" in feed ? feed.changedFields : []).toEqual([
      "schedule",
    ]);
    const authOauth = plan.rows.find(
      (r) => r.kind === "auth-profile" && r.id === "x-account"
    );
    expect(
      authOauth && "needsAuth" in authOauth ? authOauth.needsAuth : undefined
    ).toBe(true);
  });

  test("undeclared remote connector becomes an informational note (no uninstall)", () => {
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      connectorDefinitions: [
        builtinConnectorDef,
        {
          key: "legacy",
          name: "Legacy",
          installed: true,
          installable: false,
        },
      ],
    };
    const plan = computeDiff(connectorState(), remote);
    expect(plan.notes.some((n) => n.includes('"legacy"'))).toBe(true);
    expect(
      plan.rows.some(
        (r) => r.kind === "connector-definition" && r.id === "legacy"
      )
    ).toBe(false);
  });

  test("connectors are skipped when --only is set", () => {
    const plan = computeDiff(connectorState(), emptyRemote(), {
      only: "agents",
    });
    expect(plan.rows.some((r) => r.kind === "connection")).toBe(false);
    expect(plan.rows.some((r) => r.kind === "connector-definition")).toBe(
      false
    );
  });

  test("render includes the connectors sections", () => {
    const plan = computeDiff(connectorState(), {
      ...emptyRemote(),
      connectorDefinitions: [builtinConnectorDef],
    });
    expect(renderPlan(plan)).toMatchSnapshot();
  });

  // ── round-2 ──────────────────────────────────────────────────────────────

  test("connection slug bound to a different connector remotely is a hard error", () => {
    expect(() =>
      computeDiff(connectorState(), {
        ...emptyRemote(),
        connectorDefinitions: [builtinConnectorDef],
        connections: [
          {
            id: 9,
            slug: "hn-frontpage",
            connector_key: "rss",
            status: "active",
            auth_profile_slug: null,
            app_auth_profile_slug: null,
            config: {},
          },
        ],
      })
    ).toThrow(/bound to connector "rss" remotely.*declares "hackernews"/);
  });

  test("auth-profile slug bound to a different kind remotely is a hard error", () => {
    expect(() =>
      computeDiff(connectorState(), {
        ...emptyRemote(),
        connectorDefinitions: [builtinConnectorDef],
        authProfiles: [
          {
            slug: "hn-token",
            connector_key: "hackernews",
            profile_kind: "oauth_app",
            status: "active",
          },
        ],
      })
    ).toThrow(/auth_profile "hn-token" is bound to hackernews\/oauth_app/);
  });

  test("credential rotation re-pushes: env profile shows update (credentials)", () => {
    const plan = computeDiff(connectorState(), {
      ...emptyRemote(),
      connectorDefinitions: [builtinConnectorDef],
      authProfiles: [
        {
          slug: "hn-token",
          display_name: "HN token",
          connector_key: "hackernews",
          profile_kind: "env",
          status: "active",
        },
      ],
    });
    const row = plan.rows.find(
      (r) => r.kind === "auth-profile" && r.id === "hn-token"
    );
    expect(row?.verb).toBe("update");
    expect(row && "changedFields" in row ? row.changedFields : []).toContain(
      "credentials"
    );
  });

  test("a fully-converged remote state produces no connector create/update (except idempotent connector-def re-push)", () => {
    // Build a remote snapshot that exactly mirrors connectorState(): the env
    // auth profile has no declared-credential drift suppression, so it would
    // re-push (update credentials). The acme connector def is installed, so it
    // shows as a (no-op-on-server) "update". Everything else is noop.
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      connectorDefinitions: [
        { key: "hackernews", installed: false, installable: true },
        { key: "x", installed: false, installable: true },
        { key: "acme", installed: true, installable: false },
      ],
      authProfiles: [
        {
          slug: "hn-token",
          display_name: "HN token",
          connector_key: "hackernews",
          profile_kind: "env",
          status: "active",
        },
        {
          slug: "x-account",
          connector_key: "x",
          profile_kind: "oauth_account",
          status: "active",
        },
      ],
      connections: [
        {
          id: 7,
          slug: "hn-frontpage",
          connector_key: "hackernews",
          display_name: "HN front page",
          status: "active",
          auth_profile_slug: "hn-token",
          app_auth_profile_slug: null,
          config: {},
        },
      ],
      feedsByConnectionId: new Map([
        [
          7,
          [
            {
              id: 11,
              connection_id: 7,
              feed_key: "stories",
              status: "active",
              schedule: "0 * * * *",
              config: {},
            },
          ],
        ],
      ]),
    };
    const plan = computeDiff(connectorState(), remote);
    // Only "update" rows allowed: the connector-def re-push and the
    // env-credential re-push — both idempotent on the server.
    const nonIdempotentChurn = plan.rows.filter(
      (r) =>
        (r.verb === "create" || r.verb === "update") &&
        !(r.kind === "connector-definition") &&
        !(r.kind === "auth-profile" && r.id === "hn-token")
    );
    expect(nonIdempotentChurn).toEqual([]);
    expect(plan.notes).toEqual([]);
  });

  test("connector-definition with an already-installed key renders as update, not create", () => {
    const installedAcme = { key: "acme", installed: true, installable: false };
    const plan = computeDiff(connectorState(), {
      ...emptyRemote(),
      connectorDefinitions: [builtinConnectorDef, installedAcme],
    });
    // connectorState()'s acme def has key:"acme"; it is installed remotely.
    const row = plan.rows.find(
      (r) => r.kind === "connector-definition" && r.id?.startsWith("acme")
    );
    expect(row?.verb).toBe("update");
  });

  // ── round-4 ──────────────────────────────────────────────────────────────

  test("referenced-but-not-installed bundled connector becomes a connector-definition create row", () => {
    const plan = computeDiff(connectorState(), {
      ...emptyRemote(),
      connectorDefinitions: [
        // hackernews: installable + has a server-side source_uri, not installed
        {
          key: "hackernews",
          installed: false,
          installable: true,
          source_uri: "file:///app/connectors/hackernews.ts",
        },
        // x: same
        {
          key: "x",
          installed: false,
          installable: true,
          source_uri: "file:///app/connectors/x.ts",
        },
      ],
    });
    const hn = plan.rows.find(
      (r) => r.kind === "connector-definition" && r.id === "hackernews"
    );
    expect(hn?.verb).toBe("create");
    const x = plan.rows.find(
      (r) => r.kind === "connector-definition" && r.id === "x"
    );
    expect(x?.verb).toBe("create");
    // acme is locally declared (sourcePath) — it still gets its own row.
    expect(
      plan.rows.some(
        (r) => r.kind === "connector-definition" && r.id?.startsWith("acme")
      )
    ).toBe(true);
  });

  test("a locally-supplied connector key is NOT also a bundled-install row (no double mutation)", () => {
    // Pretend "acme" is *also* in the bundled catalog with a source_uri; the
    // local .connector.ts should win — no bundled row for "acme".
    const state = connectorState();
    // Make a connection reference "acme" so it's in referencedConnectorKeys.
    state.connectors.connections.push({
      slug: "acme-conn",
      connector: "acme",
      feeds: [],
      sourceFile: "connectors/acme.yaml",
    });
    const plan = computeDiff(state, {
      ...emptyRemote(),
      connectorDefinitions: [
        {
          key: "acme",
          installed: false,
          installable: true,
          source_uri: "file:///app/connectors/acme.ts",
        },
      ],
    });
    const acmeRows = plan.rows.filter(
      (r) => r.kind === "connector-definition" && r.id?.startsWith("acme")
    );
    // Exactly one row — the locally-declared def — never a bundled duplicate.
    expect(acmeRows).toHaveLength(1);
  });
});
