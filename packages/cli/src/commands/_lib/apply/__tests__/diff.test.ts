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
    connections: [],
    ...overrides,
  };
}

function buildState(agents: DesiredAgent[]): DesiredState {
  return {
    agents,
    memorySchema: { entityTypes: [], relationshipTypes: [] },
    requiredSecrets: [],
  };
}

function emptyRemote(): RemoteSnapshot {
  return {
    agents: [],
    agentSettings: new Map(),
    connectionsByAgent: new Map(),
    entityTypes: [],
    relationshipTypes: [],
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
      connectionsByAgent: new Map([["triage", []]]),
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
      connectionsByAgent: new Map([["triage", []]]),
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
      connectionsByAgent: new Map([["triage", []]]),
    };
    const plan = computeDiff(desired, remote);
    const settingsRow = plan.rows.find((r) => r.kind === "settings");
    expect(settingsRow?.verb).toBe("update");
    if (settingsRow?.kind === "settings") {
      expect(settingsRow.changedFields).toContain("networkConfig");
    }
    expect(renderPlan(plan)).toMatchSnapshot();
  });
});

describe("apply diff — connections", () => {
  test("create on empty remote", () => {
    const desired = buildState([
      buildDesiredAgent("triage", {
        metadata: { agentId: "triage", name: "Triage" },
        connections: [
          {
            stableId: "triage-telegram",
            type: "telegram",
            config: { botToken: "abc" },
          },
        ],
      }),
    ]);
    const plan = computeDiff(desired, emptyRemote());
    const connRow = plan.rows.find((r) => r.kind === "connection");
    expect(connRow?.verb).toBe("create");
    expect(renderPlan(plan)).toMatchSnapshot();
  });

  test("update with willRestart when config changes", () => {
    const desired = buildState([
      buildDesiredAgent("triage", {
        metadata: { agentId: "triage", name: "Triage" },
        connections: [
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
      connectionsByAgent: new Map([
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
    const connRow = plan.rows.find((r) => r.kind === "connection");
    expect(connRow?.verb).toBe("update");
    if (connRow?.kind === "connection") {
      expect(connRow.willRestart).toBe(true);
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

describe("renderSummary", () => {
  test("renders zero-row plan", () => {
    const desired = buildState([]);
    const plan = computeDiff(desired, emptyRemote());
    expect(renderSummary(plan)).toMatchSnapshot();
  });
});
