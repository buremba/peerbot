import { describe, expect, test } from "bun:test";
import chalk from "chalk";
import type { DesiredEntityType, DesiredState } from "../desired-state.js";
import {
  computeDiff,
  ownedKey,
  type Baseline,
  type RemoteSnapshot,
} from "../diff.js";

chalk.level = 0;

function buildState(entityTypes: DesiredEntityType[]): DesiredState {
  return {
    agents: [],
    prune: false,
    memorySchema: { entityTypes, relationshipTypes: [] },
    watchers: [],
    connectors: { definitions: [], authProfiles: [], connections: [] },
    providers: [],
    requiredSecrets: [],
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

function taskType(
  overrides: Partial<DesiredEntityType> = {}
): DesiredEntityType {
  return {
    slug: "task",
    name: "Task",
    required: ["status"],
    properties: {
      status: {
        type: "string",
        enum: ["backlog", "active", "done"],
      },
    },
    ...overrides,
  };
}

function remoteTask(id = 1, overrides: Record<string, unknown> = {}): any {
  return {
    id,
    slug: "task",
    name: "Task",
    required: ["status"],
    properties: {
      status: {
        type: "string",
        enum: ["backlog", "active", "done"],
      },
    },
    organization_id: "org-1",
    ...overrides,
  };
}

function baselineFor(
  attribution: RemoteSnapshot["entityTypes"],
  ownedIds: number[]
): Baseline {
  return {
    attribution: {
      entityTypes: attribution,
      relationshipTypes: [],
      watchers: [],
    },
    owned: new Set(ownedIds.map((id) => ownedKey("entity-type", id))),
  };
}

describe("three-way attribution (baseline present)", () => {
  test("config moved a field with remote untouched → converges (update)", () => {
    const desired = buildState([
      taskType({
        name: "Task v2",
        properties: {
          status: {
            type: "string",
            enum: ["backlog", "active", "done", "archived"],
          },
        },
      }),
    ]);
    const remote = emptyRemote();
    remote.entityTypes = [remoteTask()];
    const baseline = baselineFor([remoteTask()], [1]);

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
    });
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("update");
    expect("changedFields" in row! ? row.changedFields : []).toEqual(
      expect.arrayContaining(["name", "properties.status"])
    );
    expect(plan.counts.drift).toBe(0);
  });

  test("remote moved an un-declared annotation (board role) → blocking drift", () => {
    const desired = buildState([
      taskType(), // config does NOT declare x-lobu.role
    ]);
    const remote = emptyRemote();
    remote.entityTypes = [
      remoteTask(1, {
        properties: {
          status: {
            type: "string",
            enum: ["backlog", "active", "done"],
            "x-lobu": { role: "workflowState" },
          },
        },
      }),
    ];
    const baseline = baselineFor([remoteTask(1)], [1]); // baseline lacks the annotation

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
    });
    const drift = plan.rows.filter((r) => r.verb === "drift");
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      kind: "entity-type",
      id: "task",
      field: "properties.status",
      blocking: true,
    });
    expect(plan.counts.drift).toBe(1);
  });

  test("both config and remote moved the same field → blocking drift (never config-wins)", () => {
    const desired = buildState([
      taskType({
        properties: {
          status: {
            type: "string",
            enum: ["backlog", "active", "done", "blocked"],
          },
        },
      }),
    ]);
    const remote = emptyRemote();
    remote.entityTypes = [
      remoteTask(1, {
        properties: {
          status: { type: "string", enum: ["backlog", "active", "someday"] },
        },
      }),
    ];
    const baseline = baselineFor([remoteTask(1)], [1]); // baseline = original enum

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
    });
    const drift = plan.rows.filter((r) => r.verb === "drift");
    expect(drift.some((r) => r.blocking && r.id === "task")).toBe(true);
  });

  test("no-baseline (empty attribution) blocks a remote mismatch instead of converging", () => {
    const desired = buildState([taskType({ name: "Task v2" })]);
    const remote = emptyRemote();
    remote.entityTypes = [remoteTask()];
    // Baseline exists but holds NO attribution/owned — treats the org as
    // never-attributed: remote mismatches block, nothing auto-deletes.
    const baseline = baselineFor([], []);

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
    });
    expect(plan.rows.some((r) => r.verb === "drift" && r.blocking)).toBe(true);
    expect(plan.rows.some((r) => r.verb === "update")).toBe(false);
  });
});

describe("owned-based delete classification (baseline present)", () => {
  test("remote-only definition IN owned → config-expressed delete", () => {
    const desired = buildState([]);
    const remote = emptyRemote();
    remote.entityTypes = [remoteTask(7)];
    const baseline = baselineFor([remoteTask(7)], [7]);

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
    });
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("delete");
  });

  test("remote-only definition NOT in owned (UI-created) → blocking drift, never delete", () => {
    const desired = buildState([]);
    const remote = emptyRemote();
    remote.entityTypes = [remoteTask(9)]; // id 9 never applied by this config
    const baseline = baselineFor([], []);

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
    });
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("drift");
    expect((row as any).blocking).toBe(true);
    expect(plan.counts.delete).toBe(0);
  });

  test("remote-only definition IN owned but edited after baseline → blocking drift (never delete)", () => {
    const desired = buildState([]);
    const remote = emptyRemote();
    remote.entityTypes = [
      remoteTask(7, { name: "Task edited in UI" }), // differs from baseline
    ];
    const baseline = baselineFor([remoteTask(7)], [7]);

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
    });
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("drift");
    expect((row as any).blocking).toBe(true);
    expect(plan.counts.delete).toBe(0);
  });

  test("same-slug recreation (new id) after a delete-with-lost-summary → blocking drift", () => {
    const desired = buildState([]);
    const remote = emptyRemote();
    // User re-created `task` in the UI → NEW incarnation id 99, same slug/value.
    remote.entityTypes = [remoteTask(99)];
    // Stale baseline still lists the OLD id 7 as owned (the delete's summary
    // POST failed, so ownership never advanced).
    const baseline = baselineFor([remoteTask(7)], [7]);

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
    });
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("drift");
    expect((row as any).blocking).toBe(true);
    expect(plan.counts.delete).toBe(0);
  });
});

describe("three-way edge cases", () => {
  test("in-sync definition missing from baseline → noop (first baseline can be established)", () => {
    const desired = buildState([taskType()]);
    const remote = emptyRemote();
    remote.entityTypes = [remoteTask()];
    // Baseline exists but has no entry for `task` — and desired == remote.
    const baseline = baselineFor([], []);

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
    });
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("noop");
    expect(plan.counts.drift).toBe(0);
  });

  test("config-omitted unmanaged facet (eventKinds) with remote untouched → noop, never cleared", () => {
    const desired = buildState([
      taskType(), // config does NOT declare eventKinds
    ]);
    const remote = emptyRemote();
    remote.entityTypes = [
      remoteTask(1, { eventKinds: { note: { description: "ui-authored" } } }),
    ];
    const baseline = baselineFor(
      [remoteTask(1, { eventKinds: { note: { description: "ui-authored" } } })],
      [1]
    );

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
    });
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("noop");
    expect(plan.counts.update).toBe(0);
    expect(plan.counts.drift).toBe(0);
  });

  test("unchanged declared resolutionPolicy round-trips as noop", () => {
    const desired = buildState([
      taskType({
        resolutionPolicy: { "x-lobu-resolution": { rules: [{ kind: "email" }] } },
      }),
    ]);
    const remote = emptyRemote();
    remote.entityTypes = [
      remoteTask(1, {
        schemaExtras: { "x-lobu-resolution": { rules: [{ kind: "email" }] } },
      }),
    ];
    const baseline = baselineFor(
      [
        remoteTask(1, {
          schemaExtras: { "x-lobu-resolution": { rules: [{ kind: "email" }] } },
        }),
      ],
      [1]
    );

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
    });
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("noop");
    expect(plan.counts.drift).toBe(0);
  });
});

describe("Behavior three-way attribution", () => {
  function desiredWatcher(overrides: Record<string, unknown> = {}) {
    return {
      slug: "digest",
      agent: "agent-a",
      name: "Digest",
      prompt: "Summarize",
      ...overrides,
    };
  }
  function remoteWatcher(overrides: Record<string, unknown> = {}) {
    return {
      slug: "digest",
      behavior_id: "b-1",
      agent_id: "agent-a",
      name: "Digest",
      prompt: "Summarize",
      ...overrides,
    };
  }

  test("remote agent reassignment → blocking drift (never silently overwritten)", () => {
    const desired = buildState([]);
    desired.watchers = [desiredWatcher() as any];
    const remote = emptyRemote();
    remote.watchers = [remoteWatcher({ agent_id: "agent-b" }) as any];
    const baseline = {
      attribution: { entityTypes: [], relationshipTypes: [], watchers: [remoteWatcher()] },
      owned: new Set<string>(["watcher:b-1"]),
    };

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
    });
    const drift = plan.rows.filter((r) => r.verb === "drift");
    expect(drift.some((r) => (r as any).blocking && r.id === "digest")).toBe(
      true
    );
  });
});
