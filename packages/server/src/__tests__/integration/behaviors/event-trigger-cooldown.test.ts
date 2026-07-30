/**
 * `min_cooldown_seconds` must actually debounce event-triggered Behaviors.
 *
 * The column has existed (NOT NULL DEFAULT 0) and been writable through the
 * MCP contract, `defineBehavior`, and `lobu apply` since it was added, and no
 * dispatch path ever read it. An operator who set it got no debounce at all.
 *
 * WHY ONLY THE EVENT PATH: a schedule already spaces its own firings — cron IS
 * the operator's cadence control — so a cooldown there is redundant. Worse, the
 * scheduled path would have to skip materializing a run, and `next_run_at` only
 * advances when a run reaches a terminal state (see `advanceWatcherSchedule`).
 * A suppressed scheduled firing would leave the cursor in the past and the
 * Behavior would re-select on every tick forever — exactly the hot loop #2326
 * fixed. Event activations have no cursor to strand: suppressing one simply
 * means that event does not fire this Behavior. So the cooldown belongs here
 * and only here.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findMatchingBehaviorActivations } from "../../../behaviors/activation";
import type { Env } from "../../../index";
import { manageBehaviors } from "../../../tools/admin/manage_behaviors";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestAgent,
	createTestConnection,
	seedOwnerContext,
} from "../../setup/test-fixtures";

interface Fixture {
	organizationId: string;
	behaviorId: number;
	signal: {
		connector_key: string;
		connection_id: string;
		event_type: string;
		label: string;
		input_text: string;
	};
}

let counter = 0;

type OwnerContext = Awaited<ReturnType<typeof seedOwnerContext>>["ctx"];

interface Workspace {
	organizationId: string;
	agentId: string;
	connectionId: string;
	ctx: OwnerContext;
}

async function behaviorWithCooldown(
	cooldownSeconds: number,
	reuse?: Workspace,
): Promise<Fixture & { workspace: Workspace }> {
	const sql = getTestDb();
	const slug = `cooldown-${++counter}`;

	let workspace: Workspace;
	if (reuse) {
		workspace = reuse;
	} else {
		const seeded = await seedOwnerContext();
		workspace = {
			organizationId: seeded.org.id,
			ctx: seeded.ctx,
			agentId: (
				await createTestAgent({
					organizationId: seeded.org.id,
					ownerUserId: seeded.user.id,
				})
			).agentId,
			connectionId: (
				await createTestConnection({
					organization_id: seeded.org.id,
					connector_key: "github",
					created_by: seeded.user.id,
				})
			).id,
		};
	}
	const { organizationId, agentId, connectionId, ctx } = workspace;

	const created = await manageBehaviors(
		{
			action: "create",
			slug,
			name: `Cooldown ${slug}`,
			prompt: "Summarize changed pull requests.",
			agent_id: agentId,
			min_cooldown_seconds: cooldownSeconds,
			triggers: [
				{
					kind: "event",
					connector_key: "github",
					connection_id: connectionId,
					event_types: ["pull_request.updated"],
					execution: "window",
					active_run: "coalesce",
					output: "silent",
				},
			],
		},
		{} as Env,
		ctx,
	);
	if (created.action !== "create" || !("behavior_id" in created)) {
		throw new Error("Behavior creation did not complete");
	}
	const behaviorId = Number(created.behavior_id);

	// Guard the fixture itself: if the contract ever stops persisting the field,
	// every assertion below would pass vacuously against cooldown 0.
	const [row] = await sql`
    SELECT min_cooldown_seconds FROM watchers WHERE id = ${behaviorId}
  `;
	expect(Number(row.min_cooldown_seconds)).toBe(cooldownSeconds);

	return {
		organizationId,
		behaviorId,
		workspace,
		signal: {
			connector_key: "github",
			connection_id: connectionId,
			event_type: "pull_request.updated",
			label: "PR changed",
			input_text: "A pull request changed.",
		},
	};
}

/** A prior firing of this Behavior, `secondsAgo` in the past. */
async function priorRun(
	fixture: Fixture,
	secondsAgo: number,
	status = "completed",
): Promise<void> {
	const sql = getTestDb();
	await sql`
    INSERT INTO runs (organization_id, run_type, watcher_id, status, created_at)
    VALUES (${fixture.organizationId}, 'behavior', ${fixture.behaviorId},
            ${status}, now() - make_interval(secs => ${secondsAgo}))
  `;
}

async function matches(fixture: Fixture): Promise<number> {
	const found = await findMatchingBehaviorActivations(
		fixture.organizationId,
		{ ...fixture.signal, delivery_id: `event:cooldown:${++counter}` },
	);
	return found.length;
}

describe("min_cooldown_seconds debounces event-triggered Behaviors", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("suppresses an activation inside the cooldown window", async () => {
		const fixture = await behaviorWithCooldown(1800);
		await priorRun(fixture, 60);

		expect(await matches(fixture)).toBe(0);
	});

	it("allows an activation once the cooldown has elapsed", async () => {
		const fixture = await behaviorWithCooldown(1800);
		await priorRun(fixture, 7200);

		expect(await matches(fixture)).toBe(1);
	});

	it("allows the first activation when the Behavior has never run", async () => {
		const fixture = await behaviorWithCooldown(1800);

		expect(await matches(fixture)).toBe(1);
	});

	it("does not debounce at all when the cooldown is 0 (the default)", async () => {
		const fixture = await behaviorWithCooldown(0);
		await priorRun(fixture, 1);

		expect(await matches(fixture)).toBe(1);
	});

	it("counts a still-running firing, not just a finished one", async () => {
		// A burst that starts a run and immediately re-fires must be debounced by
		// the run it just started, otherwise the cooldown only works after the
		// first run happens to finish.
		const fixture = await behaviorWithCooldown(1800);
		await priorRun(fixture, 5, "running");

		expect(await matches(fixture)).toBe(0);
	});

	it("scopes the cooldown to one Behavior, not the whole connection", async () => {
		const cooling = await behaviorWithCooldown(1800);
		const sibling = await behaviorWithCooldown(0, cooling.workspace);
		await priorRun(cooling, 60);

		// Same signal reaches both Behaviors; only the cooling one is suppressed.
		expect(await matches(sibling)).toBe(1);
	});
});
