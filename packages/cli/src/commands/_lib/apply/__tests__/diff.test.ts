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
