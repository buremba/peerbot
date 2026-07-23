import { describe, expect, test } from "bun:test";
import { defineAgent, defineBehavior, defineConfig } from "@lobu/cli/config";
import type { AgentSettings } from "@lobu/core";
import chalk from "chalk";
import type { DesiredAgent, DesiredState } from "../desired-state.js";
import { computeDiff, type DiffPlan, type RemoteSnapshot } from "../diff.js";
import { mapProjectToDesiredState } from "../map-config.js";
import { renderPlan, renderProgress, renderSummary } from "../render.js";

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
    ...overrides,
  };
}

function buildState(
  agents: DesiredAgent[],
  overrides: Partial<DesiredState> = {}
): DesiredState {
  return {
    agents,
    prune: false,
    memorySchema: { entityTypes: [], relationshipTypes: [] },
    watchers: [],
    connectors: { definitions: [], authProfiles: [], connections: [] },
    providers: [],
    requiredSecrets: [],
    ...overrides,
  };
}

function emptyRemote(): RemoteSnapshot {
  return {
    agents: [],
    agentSettings: new Map(),
    entityTypes: [],
    relationshipTypes: [],
    watchers: [],
    connectorDefinitions: [],
    authProfiles: [],
    connections: [],
    feedsByConnectionId: new Map(),
    inferenceProviders: [],
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

    expect(plan.counts).toEqual({
      create: 2,
      update: 0,
      noop: 0,
      drift: 0,
      delete: 0,
    });
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
    };
    const plan = computeDiff(desired, remote);
    const settingsRow = plan.rows.find((r) => r.kind === "settings");
    expect(settingsRow?.verb).toBe("update");
    if (settingsRow?.kind === "settings") {
      expect(settingsRow.changedFields).toContain("networkConfig");
    }
    expect(renderPlan(plan)).toMatchSnapshot();
  });

  test("#5: updates when the models list changes; noop when it matches", () => {
    const desired = buildState([
      buildDesiredAgent("triage", {
        metadata: { agentId: "triage", name: "Triage" },
        settings: {
          models: ["anthropic/claude-sonnet-5", "openai/gpt-5"],
        },
      }),
    ]);
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "triage", name: "Triage" }],
      agentSettings: new Map<string, AgentSettings | null>([
        ["triage", { models: ["anthropic/claude-sonnet-5"], updatedAt: 0 }],
      ]),
    };
    const plan = computeDiff(desired, remote);
    const settingsRow = plan.rows.find((r) => r.kind === "settings");
    expect(settingsRow?.verb).toBe("update");
    if (settingsRow?.kind === "settings") {
      expect(settingsRow.changedFields).toContain("models");
    }

    // Same ordered list ⇒ noop.
    const unchanged = computeDiff(desired, {
      ...remote,
      agentSettings: new Map<string, AgentSettings | null>([
        [
          "triage",
          {
            models: ["anthropic/claude-sonnet-5", "openai/gpt-5"],
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

  test("#5: models is order-sensitive — reordering is a change (index 0 = default)", () => {
    const desired = buildState([
      buildDesiredAgent("triage", {
        metadata: { agentId: "triage", name: "Triage" },
        settings: { models: ["openai/gpt-5", "anthropic/claude-sonnet-5"] },
      }),
    ]);
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "triage", name: "Triage" }],
      agentSettings: new Map<string, AgentSettings | null>([
        [
          "triage",
          {
            models: ["anthropic/claude-sonnet-5", "openai/gpt-5"],
            updatedAt: 0,
          },
        ],
      ]),
    };
    const settingsRow = computeDiff(desired, remote).rows.find(
      (r) => r.kind === "settings"
    );
    expect(settingsRow?.verb).toBe("update");
    if (settingsRow?.kind === "settings") {
      expect(settingsRow.changedFields).toContain("models");
    }
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

  test("relationship-type rules are a noop when remote rules match (idempotency)", () => {
    // Regression: the rel-type `list` action omits rules, so apply hydrates
    // them (listRelationshipTypeRules) into the snapshot. When the hydrated
    // remote rules equal desired, the diff must be a noop — otherwise every
    // re-apply churns a perpetual "rules changed" update.
    const desired: DesiredState = {
      agents: [],
      memorySchema: {
        entityTypes: [],
        relationshipTypes: [
          {
            slug: "works-at",
            name: "Works at",
            rules: [{ source: "contact", target: "company" }],
          },
        ],
      },
      watchers: [],
      requiredSecrets: [],
    };
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      relationshipTypes: [
        {
          slug: "works-at",
          name: "Works at",
          rules: [{ source: "contact", target: "company" }],
        },
      ],
    };
    const plan = computeDiff(desired, remote);
    expect(plan.counts.noop).toBe(1);
    expect(plan.counts.update).toBe(0);
  });

  test("relationship-type rules update when remote rules differ", () => {
    const desired: DesiredState = {
      agents: [],
      memorySchema: {
        entityTypes: [],
        relationshipTypes: [
          {
            slug: "works-at",
            name: "Works at",
            rules: [{ source: "contact", target: "company" }],
          },
        ],
      },
      watchers: [],
      requiredSecrets: [],
    };
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      relationshipTypes: [{ slug: "works-at", name: "Works at", rules: [] }],
    };
    const plan = computeDiff(desired, remote);
    expect(plan.counts.update).toBe(1);
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
    };
    const plan = computeDiff(desiredEmpty, remoteWithItems);
    expect(plan.counts.update).toBeGreaterThan(0);
  });
});

describe("apply diff — watchers", () => {
  const desiredWatcher = {
    slug: "weekly-digest",
    agent: "triage",
    name: "Weekly digest",
    prompt: "Produce a digest.",
    triggers: [{ kind: "schedule" as const, cron: "0 9 * * 1" }],
  };

  test("create when watcher missing remotely", () => {
    const desired = buildState([], { watchers: [desiredWatcher] });
    const plan = computeDiff(desired, emptyRemote());
    const row = plan.rows.find((r) => r.kind === "watcher");
    expect(row?.verb).toBe("create");
    expect(row?.id).toBe("weekly-digest");
  });

  test("noop when remote matches every field the diff covers", () => {
    const desired = buildState([], { watchers: [desiredWatcher] });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      watchers: [
        {
          slug: "weekly-digest",
          name: "Weekly digest",
          agent_id: "triage",
          prompt: "Produce a digest.",
          triggers: [{ kind: "schedule", cron: "0 9 * * 1" }],
        },
      ],
    };
    const plan = computeDiff(desired, remote);
    const row = plan.rows.find((r) => r.kind === "watcher");
    expect(row?.verb).toBe("noop");
    expect(plan.counts.create).toBe(0);
  });

  test("noop after the server expands minimally authored trigger defaults", () => {
    const agent = defineAgent({ id: "triage" });
    const desired = mapProjectToDesiredState(
      defineConfig({
        agents: [agent],
        behaviors: [
          defineBehavior({
            agent,
            slug: "minimal-schedule",
            prompt: "Produce a digest.",
            triggers: [{ kind: "schedule", cron: "0 9 * * 1" }],
          }),
        ],
      })
    );
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "triage", name: "triage" }],
      agentSettings: new Map([["triage", null]]),
      watchers: [
        {
          slug: "minimal-schedule",
          agent_id: "triage",
          prompt: "Produce a digest.",
          triggers: [
            {
              kind: "schedule",
              cron: "0 9 * * 1",
              timezone: null,
              execution: "window",
              active_run: "coalesce",
              skip_if_unchanged: true,
            },
          ],
        },
      ],
    };

    const row = computeDiff(desired, remote).rows.find(
      (candidate) => candidate.kind === "watcher"
    );
    expect(row?.verb).toBe("noop");
  });

  test("update when a schedule trigger changes remotely", () => {
    const desired = buildState([], { watchers: [desiredWatcher] });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      watchers: [
        {
          slug: "weekly-digest",
          name: "Weekly digest",
          agent_id: "triage",
          prompt: "Produce a digest.",
          triggers: [{ kind: "schedule", cron: "0 10 * * 1" }],
        },
      ],
    };
    const plan = computeDiff(desired, remote);
    const row = plan.rows.find((r) => r.kind === "watcher");
    expect(row?.verb).toBe("update");
    expect(row?.changedFields).toContain("triggers");
    expect(
      (row as { versionBoundFields?: string[] }).versionBoundFields
    ).toBeUndefined();
  });

  test("update with version-bound drift when prompt changes remotely", () => {
    const desired = buildState([], { watchers: [desiredWatcher] });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      watchers: [
        {
          slug: "weekly-digest",
          name: "Weekly digest",
          agent_id: "triage",
          prompt: "Old prompt",
          triggers: [{ kind: "schedule", cron: "0 9 * * 1" }],
        },
      ],
    };
    const plan = computeDiff(desired, remote);
    const row = plan.rows.find((r) => r.kind === "watcher");
    expect(row?.verb).toBe("update");
    expect(
      (row as { versionBoundFields?: string[] }).versionBoundFields
    ).toEqual(["prompt"]);
  });

  test("reaction_script declared → always re-pushed (idempotent)", () => {
    const desired = buildState([], {
      watchers: [
        {
          ...desiredWatcher,
          reactionScript: {
            sourcePath: "/abs/path/r.ts",
            sourceCode: "export default async () => {};",
          },
        },
      ],
    });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      watchers: [
        {
          slug: "weekly-digest",
          name: "Weekly digest",
          agent_id: "triage",
          prompt: "Produce a digest.",
          triggers: [{ kind: "schedule", cron: "0 9 * * 1" }],
        },
      ],
    };
    const plan = computeDiff(desired, remote);
    const row = plan.rows.find((r) => r.kind === "watcher");
    expect(row?.verb).toBe("update");
    expect(row?.changedFields).toEqual(["reaction_script"]);
    expect(
      (row as { reactionScriptDeclared?: boolean }).reactionScriptDeclared
    ).toBe(true);
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

describe("renderPlan — behavior labels (not watcher)", () => {
  /** Labels/headings only — not substrings of resource slugs. */
  function expectNoWatcherLabels(text: string): void {
    expect(text).not.toMatch(/(?:^|\n)\s*watchers?:\s*(?:\n|$)/);
    expect(text).not.toMatch(/[+=~?-]\s+watcher\s+\S/);
  }

  test("plan create/update/drift rows print behavior, never watcher", () => {
    const plan: DiffPlan = {
      rows: [
        { kind: "watcher", verb: "update", id: "weekly-digest" },
        { kind: "watcher", verb: "create", id: "new-digest" },
        { kind: "watcher", verb: "drift", id: "orphaned-digest" },
      ],
      counts: { create: 1, update: 1, noop: 0, drift: 1, delete: 0 },
      notes: [],
    };

    const text = renderPlan(plan);
    expect(text).toContain("behaviors:");
    expect(text).toContain("behavior new-digest");
    expect(text).toContain("behavior weekly-digest");
    expect(text).toContain("behavior orphaned-digest");
    expectNoWatcherLabels(text);
    expect(text).toMatchSnapshot();
  });

  test("renderProgress uses the behavior label for watcher-kind rows", () => {
    const line = renderProgress("create", "watcher", "weekly-digest");
    expect(line).toContain("behavior weekly-digest");
    expectNoWatcherLabels(line);
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

  test("creates a virtual feed from config; virtual/collected kind is immutable on drift (#1899)", () => {
    const desired = buildState([], {
      connectors: {
        definitions: [],
        authProfiles: [
          {
            slug: "wh-env",
            connector: "postgres",
            kind: "env" as const,
            credentials: { DATABASE_URL: "$DATABASE_URL" },
            sourceFile: "connectors/postgres.yaml",
          },
        ],
        connections: [
          {
            slug: "warehouse",
            connector: "postgres",
            authProfileSlug: "wh-env",
            feeds: [
              {
                feedKey: "query",
                virtual: true,
                config: { query: "SELECT 1" },
              },
            ],
            sourceFile: "connectors/postgres.yaml",
          },
        ],
      },
    });

    // No remote feed yet → the virtual feed is a create.
    const createPlan = computeDiff(desired, {
      ...emptyRemote(),
      connections: [
        {
          id: 9,
          slug: "warehouse",
          connector_key: "postgres",
          status: "active",
          auth_profile_slug: "wh-env",
          app_auth_profile_slug: null,
          config: {},
        },
      ],
    });
    expect(createPlan.rows.find((r) => r.kind === "feed")?.verb).toBe("create");

    // Remote has the same key as a COLLECTED feed → kind mismatch is a hard error
    // (immutable), not a silent update that apply couldn't persist.
    expect(() =>
      computeDiff(desired, {
        ...emptyRemote(),
        connections: [
          {
            id: 9,
            slug: "warehouse",
            connector_key: "postgres",
            status: "active",
            auth_profile_slug: "wh-env",
            app_auth_profile_slug: null,
            config: {},
          },
        ],
        feedsByConnectionId: new Map([
          [
            9,
            [
              {
                id: 21,
                connection_id: 9,
                feed_key: "query",
                status: "active",
                config: { query: "SELECT 1" },
                virtual: false,
              },
            ],
          ],
        ]),
      })
    ).toThrow(/virtual\/collected kind is immutable/);
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

  test("BYO chat connection always reaches the chat upsert (rotation-safe)", () => {
    // Desired config holds a resolved token (plaintext); the server stores it as
    // a `secret://` ref, so the CLI can't compare them or detect a rotation. The
    // row must always be an `update` (never noop) so it reaches the idempotent
    // apply_chat_connection, which compares secrets server-side and no-ops when
    // nothing changed. A noop here would silently drop credential rotations.
    const desired = buildState([], {
      connectors: {
        definitions: [],
        authProfiles: [],
        connections: [
          {
            slug: "team-slack",
            connector: "slack",
            credentialMode: "byo" as const,
            config: { botToken: "xoxb-real-token" },
            feeds: [],
            sourceFile: "lobu.config.ts",
          },
        ],
      },
    });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      // listConnections strips the `agentconn-` slug namespace back to the slug.
      connections: [
        {
          id: 9,
          slug: "team-slack",
          connector_key: "slack",
          display_name: "Stored workspace name",
          status: "active",
          auth_profile_slug: null,
          app_auth_profile_slug: null,
          credential_mode: "byo",
          config: { botToken: "secret://slack/team-slack/botToken" },
        },
      ],
    };
    const conn = computeDiff(desired, remote).rows.find(
      (r) => r.kind === "connection" && r.id === "team-slack"
    );
    expect(conn?.verb).toBe("update");
    // Optional names use "omitted = no opinion" semantics. The row updates
    // only because BYO credentials are always re-pushed for rotation safety.
    expect(conn?.changedFields).toEqual(["config"]);
  });

  test("BYO chat connection ignores auth/app_auth/device_worker drift", () => {
    // A BYO chat row applies through `apply_chat_connection`, which only
    // persists slug/connector/name/config. If the remote row carries a stray
    // auth profile, app-auth profile, or device pin, the diff must NOT report
    // those as changed — apply can't clear them, so they'd resurface as a
    // perpetual "update" every run. Only `config` (rotation-safe) may change.
    const desired = buildState([], {
      connectors: {
        definitions: [],
        authProfiles: [],
        connections: [
          {
            slug: "team-slack",
            connector: "slack",
            credentialMode: "byo" as const,
            config: { botToken: "xoxb-real-token" },
            feeds: [],
            sourceFile: "lobu.config.ts",
          },
        ],
      },
    });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      connections: [
        {
          id: 9,
          slug: "team-slack",
          connector_key: "slack",
          display_name: null,
          status: "active",
          auth_profile_slug: "stray-auth",
          app_auth_profile_slug: "stray-app-auth",
          device_worker_id: "11111111-1111-1111-1111-111111111111",
          credential_mode: "byo",
          config: { botToken: "secret://slack/team-slack/botToken" },
        },
      ],
    };
    const conn = computeDiff(desired, remote).rows.find(
      (r) => r.kind === "connection" && r.id === "team-slack"
    );
    expect(conn?.verb).toBe("update");
    // Only the rotation-safe `config` field — never the unappliable ones.
    expect(
      conn?.kind === "connection" ? conn.changedFields : undefined
    ).toEqual(["config"]);
  });
});

describe("apply diff — prune", () => {
  // Remote state that has definitions + a connection the desired config drops.
  function remoteWithExtras(): RemoteSnapshot {
    return {
      ...emptyRemote(),
      entityTypes: [{ slug: "lead", properties: {} }, { slug: "stale-entity" }],
      relationshipTypes: [{ slug: "stale-rel" }],
      watchers: [{ slug: "stale-watcher", behavior_id: "42" }],
      // stale-conn is dropped from config but exempt (drift); the connector "x"
      // it still uses must therefore be spared from prune.
      connections: [
        { id: 7, slug: "stale-conn", connector_key: "x", status: "ok" },
      ],
      connectorDefinitions: [
        { key: "x", installed: true },
        { key: "orphan-connector", installed: true },
      ],
    };
  }

  function desiredKeepingLead(): DesiredState {
    return buildState([], {
      memorySchema: {
        entityTypes: [{ slug: "lead", properties: {} }],
        relationshipTypes: [],
      },
    });
  }

  test("default (prune off) reports removed definitions as drift, never delete", () => {
    const plan = computeDiff(desiredKeepingLead(), remoteWithExtras());
    expect(plan.counts.delete).toBe(0);
    expect(plan.rows.some((r) => r.verb === "delete")).toBe(false);
    expect(
      plan.rows.find((r) => r.kind === "entity-type" && r.id === "stale-entity")
        ?.verb
    ).toBe("drift");
  });

  test("prune deletes removed entity/relationship/watcher/connector definitions", () => {
    const plan = computeDiff(desiredKeepingLead(), remoteWithExtras(), {
      prune: true,
    });
    const deletes = plan.rows.filter((r) => r.verb === "delete");
    const deletedIds = deletes.map((r) => `${r.kind}:${r.id}`).sort();
    expect(deletedIds).toEqual([
      "connector-definition:orphan-connector",
      "entity-type:stale-entity",
      "relationship-type:stale-rel",
      "watcher:stale-watcher",
    ]);
    expect(plan.counts.delete).toBe(4);
    // The kept entity type is a noop, not a delete.
    expect(
      plan.rows.find((r) => r.kind === "entity-type" && r.id === "lead")?.verb
    ).toBe("noop");
  });

  test("prune never deletes data, connections, or agents", () => {
    const desired = buildState(
      [
        buildDesiredAgent("kept", {
          metadata: { agentId: "kept", name: "Kept" },
        }),
      ],
      {
        memorySchema: { entityTypes: [], relationshipTypes: [] },
      }
    );
    const remote: RemoteSnapshot = {
      ...remoteWithExtras(),
      agents: [{ agentId: "gone-agent", name: "Gone" }],
      agentSettings: new Map([["kept", null]]),
    };
    const plan = computeDiff(desired, remote, { prune: true });
    // Connection removed from config is drift (exempt), not delete.
    expect(
      plan.rows.find((r) => r.kind === "connection" && r.id === "stale-conn")
        ?.verb
    ).toBe("drift");
    // Remote agent absent from desired is drift (exempt), not delete.
    expect(
      plan.rows.find((r) => r.kind === "agent" && r.id === "gone-agent")?.verb
    ).toBe("drift");
  });

  test("prune never deletes public types owned by another org", () => {
    // The list endpoint returns this org's types PLUS public types from other
    // orgs. With orgId set, a foreign-org type must not be pruned even if it's
    // absent from the config.
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      entityTypes: [
        { slug: "lead", properties: {}, organization_id: "org_self" },
        { slug: "stale-mine", organization_id: "org_self" },
        { slug: "public-other", organization_id: "org_other" },
      ],
      relationshipTypes: [
        { slug: "stale-rel-mine", organization_id: "org_self" },
        { slug: "public-rel-other", organization_id: "org_other" },
      ],
    };
    const plan = computeDiff(desiredKeepingLead(), remote, {
      prune: true,
      orgId: "org_self",
    });
    const deletedIds = plan.rows
      .filter((r) => r.verb === "delete")
      .map((r) => `${r.kind}:${r.id}`)
      .sort();
    // Only the org's own removed types — never the foreign public ones.
    expect(deletedIds).toEqual([
      "entity-type:stale-mine",
      "relationship-type:stale-rel-mine",
    ]);
    expect(deletedIds.some((id) => id.includes("other"))).toBe(false);
  });

  test("prune never deletes $ system entity types; domain still prune", () => {
    // Sole signal is $ slug prefix.
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      entityTypes: [
        { slug: "lead", properties: {}, organization_id: "org_self" },
        { slug: "$member", organization_id: "org_self" },
        { slug: "$resource", organization_id: "org_self" },
        { slug: "goal", organization_id: "org_self" },
        // bare channel/repo are not system (legacy names; pruneable)
        { slug: "channel", organization_id: "org_self" },
      ],
      relationshipTypes: [{ slug: "$system-rel", organization_id: "org_self" }],
      watchers: [{ slug: "$system-watcher" }],
    };
    const plan = computeDiff(desiredKeepingLead(), remote, {
      prune: true,
      orgId: "org_self",
    });
    const verbOf = (kind: string, id: string) =>
      plan.rows.find((r) => r.kind === kind && r.id === id)?.verb;
    expect(verbOf("entity-type", "$member")).toBe("drift");
    expect(verbOf("entity-type", "$resource")).toBe("drift");
    expect(verbOf("entity-type", "goal")).toBe("delete");
    expect(verbOf("entity-type", "channel")).toBe("delete");
    // $ on rel/watcher still uses slug heuristic
    expect(verbOf("relationship-type", "$system-rel")).toBe("drift");
    expect(verbOf("watcher", "$system-watcher")).toBe("drift");
  });

  test("matching prefers the org's own type over a foreign public type with the same slug", () => {
    // Server returns the org's own row first, then a public row with the same
    // slug. Matching must compare desired against the org-owned row (noop), not
    // the foreign public one (which would falsely look like an update).
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      entityTypes: [
        { slug: "lead", properties: {}, organization_id: "org_self" },
        {
          slug: "lead",
          properties: { foreign: { type: "string" } },
          organization_id: "org_other",
        },
      ],
    };
    const plan = computeDiff(desiredKeepingLead(), remote, {
      prune: true,
      orgId: "org_self",
    });
    const leadRow = plan.rows.find(
      (r) => r.kind === "entity-type" && r.id === "lead"
    );
    expect(leadRow?.verb).toBe("noop");
    expect(plan.rows.some((r) => r.verb === "delete")).toBe(false);
  });

  test("connector prune suppressed when a local def has an unresolved (null) key", () => {
    const desired = buildState([], {
      connectors: {
        definitions: [
          {
            key: null,
            sourcePath: "/proj/connectors/local.connector.ts",
            sourceCode: "export default class {}",
            sourceFile: "connectors/local.connector.ts",
          },
        ],
        authProfiles: [],
        connections: [],
      },
    });
    const plan = computeDiff(desired, remoteWithExtras(), {
      prune: true,
    });
    // Can't map remote connectors to the unnamed local def → never delete them.
    expect(
      plan.rows.some(
        (r) => r.kind === "connector-definition" && r.verb === "delete"
      )
    ).toBe(false);
  });

  test("delete rows render with a removed-from-config note + summary count", () => {
    const plan = computeDiff(desiredKeepingLead(), remoteWithExtras(), {
      prune: true,
    });
    expect(renderPlan(plan)).toContain("will be deleted");
    expect(renderSummary(plan)).toContain("4 delete");
    // Prune-off summary stays clean (no delete part).
    expect(
      renderSummary(computeDiff(desiredKeepingLead(), emptyRemote()))
    ).not.toContain("delete");
  });
});
