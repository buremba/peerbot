import { describe, expect, test } from "bun:test";
import chalk from "chalk";
import { buildAttributionAndOwned } from "../deployment.js";
import type { DesiredEntityType, DesiredState } from "../desired-state.js";
import {
	type Baseline,
	computeDiff,
	ownedKey,
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
	overrides: Partial<DesiredEntityType> = {},
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
	ownedIds: number[],
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
			expect.arrayContaining(["name", "properties.status"]),
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
	test("remote-only definition IN owned + unchanged + prune → config-expressed delete", () => {
		const desired = buildState([]);
		const remote = emptyRemote();
		remote.entityTypes = [remoteTask(7)];
		const baseline = baselineFor([remoteTask(7)], [7]);

		const plan = computeDiff(desired, remote, {
			orgId: "org-1",
			baseline,
			prune: true,
		});
		const row = plan.rows.find((r) => r.kind === "entity-type");
		expect(row?.verb).toBe("delete");
	});

	test("owned + unchanged but prune=false → drift, never delete (default is non-destructive)", () => {
		const desired = buildState([]);
		const remote = emptyRemote();
		remote.entityTypes = [remoteTask(7)];
		const baseline = baselineFor([remoteTask(7)], [7]);

		const plan = computeDiff(desired, remote, {
			orgId: "org-1",
			baseline,
			prune: false,
		});
		const row = plan.rows.find((r) => r.kind === "entity-type");
		expect(row?.verb).toBe("drift");
		expect(plan.counts.delete).toBe(0);
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
			prune: true,
		});
		const row = plan.rows.find((r) => r.kind === "entity-type");
		expect(row?.verb).toBe("drift");
		expect((row as any).blocking).toBe(true);
		expect(plan.counts.delete).toBe(0);
	});

	test("UI-created connector (unowned) with a baseline → blocking drift, never deleted under prune", () => {
		const desired = buildState([]);
		const remote = emptyRemote();
		remote.connectorDefinitions = [
			{ key: "github", id: 42, installed: true } as any,
		];
		const baseline = baselineFor([], []);

		const plan = computeDiff(desired, remote, {
			orgId: "org-1",
			baseline,
			prune: true,
		});
		const row = plan.rows.find((r) => r.kind === "connector-definition");
		expect(row?.verb).toBe("drift");
		expect((row as any).blocking).toBe(true);
		expect(plan.counts.delete).toBe(0);
	});

	test("config-applied connector (owned) + prune → delete", () => {
		const desired = buildState([]);
		const remote = emptyRemote();
		remote.connectorDefinitions = [
			{ key: "github", id: 7, installed: true, version: "1.0.0" } as any,
		];
		const baseline = baselineFor([], [7]);
		baseline.owned.add("connector-definition:7");
		baseline.connectorVersions = { github: "1.0.0" };

		const plan = computeDiff(desired, remote, {
			orgId: "org-1",
			baseline,
			prune: true,
		});
		const row = plan.rows.find((r) => r.kind === "connector-definition");
		expect(row?.verb).toBe("delete");
	});

	test("owned connector edited after baseline (version change) → blocking drift, never delete", () => {
		const desired = buildState([]);
		const remote = emptyRemote();
		// Same incarnation id, but version advanced via out-of-band reinstall.
		remote.connectorDefinitions = [
			{ key: "github", id: 7, installed: true, version: "2.0.0" } as any,
		];
		const baseline = baselineFor([], [7]);
		baseline.owned.add("connector-definition:7");
		baseline.connectorVersions = { github: "1.0.0" };

		const plan = computeDiff(desired, remote, {
			orgId: "org-1",
			baseline,
			prune: true,
		});
		const row = plan.rows.find((r) => r.kind === "connector-definition");
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
			prune: true,
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
			[1],
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

	test("under prune, already-empty required stays noop (no perpetual update)", () => {
		// Config omits required; remote/attribution already []. Must not emit
		// config-moved forever from undefined ≠ [].
		const desired = buildState([
			{
				slug: "task",
				name: "Task",
				properties: {
					status: { type: "string", enum: ["backlog", "active", "done"] },
				},
				// required intentionally omitted
			},
		]);
		const remote = emptyRemote();
		remote.entityTypes = [
			remoteTask(1, { required: [] }), // already cleared
		];
		const baseline = baselineFor([remoteTask(1, { required: [] })], [1]);

		const plan = computeDiff(desired, remote, {
			orgId: "org-1",
			baseline,
			prune: true,
		});
		const row = plan.rows.find((r) => r.kind === "entity-type");
		expect(row?.verb).toBe("noop");
		expect(plan.counts.update).toBe(0);
	});

	test("relationship rules omission records [] so a later config rule change converges", () => {
		// Config omits rules; apply clears them to []. Baseline must not keep the
		// pre-apply remote rules or the next rule edit looks like remote drift.
		const desired = buildState([]);
		desired.memorySchema.relationshipTypes = [
			{ slug: "owns", name: "Owns" } as any, // no rules
		];
		const remote = emptyRemote();
		remote.relationshipTypes = [
			{
				id: 3,
				slug: "owns",
				name: "Owns",
				rules: [{ source: "a", target: "b" }],
				organization_id: "org-1",
			} as any,
		];
		const recorded = buildAttributionAndOwned(desired, remote, "org-1", false);
		const attr = recorded.attribution.relationshipTypes[0] as {
			rules?: unknown;
		};
		expect(attr.rules).toEqual([]);
	});

	test("outside prune, omitted description is preserved so a later owned delete stays eligible", () => {
		const desired = buildState([taskType()]); // no description
		const remote = emptyRemote();
		remote.entityTypes = [remoteTask(1, { description: "ui-authored blurb" })];
		const recorded = buildAttributionAndOwned(desired, remote, "org-1", false);
		const attr = recorded.attribution.entityTypes[0] as {
			description?: string;
		};
		expect(attr.description).toBe("ui-authored blurb");

		const afterRemote = emptyRemote();
		afterRemote.entityTypes = [
			remoteTask(1, { description: "ui-authored blurb" }),
		];
		const baseline: Baseline = {
			attribution: {
				entityTypes: recorded.attribution
					.entityTypes as Baseline["attribution"]["entityTypes"],
				relationshipTypes: [],
				watchers: [],
			},
			owned: new Set(recorded.owned),
		};
		const plan = computeDiff(buildState([]), afterRemote, {
			orgId: "org-1",
			baseline,
			prune: true,
		});
		expect(plan.rows.find((r) => r.kind === "entity-type")?.verb).toBe(
			"delete",
		);
	});

	test("under prune, recording attribution clears omitted facets so a later delete stays eligible", () => {
		// Config omits eventKinds under prune → apply clears them. The recorded
		// baseline must NOT keep the pre-apply eventKinds, or removing the type
		// next would look like a post-baseline edit and block.
		const desired = buildState([taskType()]); // no eventKinds
		const remote = emptyRemote();
		remote.entityTypes = [
			remoteTask(1, { eventKinds: { note: { description: "ui" } } }),
		];
		const recorded = buildAttributionAndOwned(desired, remote, "org-1", true);
		const attr = recorded.attribution.entityTypes[0] as {
			eventKinds?: unknown;
		};
		expect(attr.eventKinds).toBeUndefined();

		// After apply the remote matches the cleared attribution.
		const afterRemote = emptyRemote();
		afterRemote.entityTypes = [remoteTask(1)]; // no eventKinds
		const baseline: Baseline = {
			attribution: {
				entityTypes: recorded.attribution
					.entityTypes as Baseline["attribution"]["entityTypes"],
				relationshipTypes: [],
				watchers: [],
			},
			owned: new Set(recorded.owned),
		};
		// Now remove the type from config — owned + unchanged → delete under prune.
		const emptyDesired = buildState([]);
		const plan = computeDiff(emptyDesired, afterRemote, {
			orgId: "org-1",
			baseline,
			prune: true,
		});
		const row = plan.rows.find((r) => r.kind === "entity-type");
		expect(row?.verb).toBe("delete");
	});

	test("unchanged declared resolutionPolicy round-trips as noop", () => {
		const desired = buildState([
			taskType({
				resolutionPolicy: {
					"x-lobu-resolution": { rules: [{ kind: "email" }] },
				},
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
			[1],
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
			attribution: {
				entityTypes: [],
				relationshipTypes: [],
				watchers: [remoteWatcher()],
			},
			owned: new Set<string>(["watcher:b-1"]),
		};

		const plan = computeDiff(desired, remote, {
			orgId: "org-1",
			baseline,
		});
		const drift = plan.rows.filter((r) => r.verb === "drift");
		const row = drift.find((r) => (r as any).blocking && r.id === "digest");
		expect(row).toBeTruthy();
		// Per-field: only the remote-moved agent blocks (not the whole definition).
		expect((row as any).field).toBe("agent");
	});

	test("unnamed Behavior inherits remote name (server slug default) — second apply is noop", () => {
		const desired = buildState([]);
		// Config omits name — server stored name as the slug.
		desired.watchers = [
			{
				slug: "digest",
				agent: "agent-a",
				prompt: "Summarize",
			} as any,
		];
		const remote = emptyRemote();
		remote.watchers = [
			remoteWatcher({ name: "digest", prompt: "Summarize" }) as any,
		];
		const baseline = {
			attribution: {
				entityTypes: [],
				relationshipTypes: [],
				watchers: [remoteWatcher({ name: "digest", prompt: "Summarize" })],
			},
			owned: new Set<string>(["watcher:b-1"]),
		};
		const plan = computeDiff(desired, remote, { orgId: "org-1", baseline });
		expect(plan.rows.some((r) => r.verb === "drift" && r.blocking)).toBe(false);
		expect(
			plan.rows.find((r) => r.kind === "watcher" && r.id === "digest")?.verb,
		).toBe("noop");
	});

	test("declared Behavior rename is an update (not a silent noop)", () => {
		const desired = buildState([]);
		desired.watchers = [desiredWatcher({ name: "Daily Digest" }) as any];
		const remote = emptyRemote();
		remote.watchers = [remoteWatcher({ name: "Digest" }) as any];
		const baseline = {
			attribution: {
				entityTypes: [],
				relationshipTypes: [],
				watchers: [remoteWatcher({ name: "Digest" })],
			},
			owned: new Set<string>(["watcher:b-1"]),
		};
		const plan = computeDiff(desired, remote, { orgId: "org-1", baseline });
		const row = plan.rows.find(
			(r) => r.kind === "watcher" && r.id === "digest",
		);
		expect(row?.verb).toBe("update");
		expect(row && "changedFields" in row ? row.changedFields : []).toContain(
			"name",
		);
	});

	test("adopted remote agent + config prompt change converges (no whole-object false block)", () => {
		// Remote moved agent to B; config adopts B and also changes prompt.
		// Whole-object three-way would block; per-field must converge the prompt.
		const desired = buildState([]);
		desired.watchers = [
			desiredWatcher({ agent: "agent-b", prompt: "new prompt" }) as any,
		];
		const remote = emptyRemote();
		remote.watchers = [
			remoteWatcher({
				agent_id: "agent-b",
				prompt: "old prompt",
			}) as any,
		];
		const baseline = {
			attribution: {
				entityTypes: [],
				relationshipTypes: [],
				watchers: [
					remoteWatcher({ agent_id: "agent-a", prompt: "old prompt" }),
				],
			},
			owned: new Set<string>(["watcher:b-1"]),
		};

		const plan = computeDiff(desired, remote, {
			orgId: "org-1",
			baseline,
		});
		expect(plan.rows.some((r) => r.verb === "drift" && r.blocking)).toBe(false);
		const row = plan.rows.find(
			(r) => r.kind === "watcher" && r.id === "digest",
		);
		expect(row?.verb).toBe("update");
	});

	test("config-omitted sources on a Behavior are unmanaged — never false-block re-apply", () => {
		// Config only declares prompt; remote carries UI-authored sources.
		// Updating prompt must converge, and the post-apply attribution must
		// preserve those sources so the next apply is a noop (not remote-moved).
		const desired = buildState([]);
		desired.watchers = [
			desiredWatcher({ prompt: "new summary" }) as any, // no sources
		];
		const sources = [{ id: "s1", kind: "events", query: "select 1" }];
		const remote = emptyRemote();
		remote.watchers = [
			remoteWatcher({ prompt: "old summary", sources }) as any,
		];
		const baseline = {
			attribution: {
				entityTypes: [],
				relationshipTypes: [],
				watchers: [remoteWatcher({ prompt: "old summary", sources })],
			},
			owned: new Set<string>(["watcher:b-1"]),
		};

		const first = computeDiff(desired, remote, { orgId: "org-1", baseline });
		const update = first.rows.find(
			(r) => r.kind === "watcher" && r.verb === "update",
		);
		expect(update).toBeTruthy();
		expect(first.rows.some((r) => r.verb === "drift" && r.blocking)).toBe(
			false,
		);

		// After apply: remote has the new prompt; sources still live remotely.
		const afterRemote = emptyRemote();
		afterRemote.watchers = [
			remoteWatcher({ prompt: "new summary", sources }) as any,
		];
		const recorded = buildAttributionAndOwned(desired, afterRemote);
		expect(
			(recorded.attribution.watchers[0] as { sources?: unknown }).sources,
		).toEqual(sources);

		const second = computeDiff(desired, afterRemote, {
			orgId: "org-1",
			baseline: {
				attribution: recorded.attribution as Baseline["attribution"],
				owned: new Set(recorded.owned),
			},
		});
		expect(second.rows.some((r) => r.verb === "drift" && r.blocking)).toBe(
			false,
		);
		expect(
			second.rows.find((r) => r.kind === "watcher" && r.id === "digest")?.verb,
		).toBe("noop");
	});
});
