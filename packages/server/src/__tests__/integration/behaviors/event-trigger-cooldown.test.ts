/**
 * `min_cooldown_seconds` must actually debounce event-triggered Behaviors.
 *
 * The column has existed (NOT NULL DEFAULT 0) and been writable through the
 * MCP contract, `defineBehavior`, and `lobu apply` since it was added, and no
 * dispatch path ever read it. An operator who set it got no debounce at all.
 *
 * WHERE THE CHECK LIVES: at the chokepoint that already serializes a Behavior
 * activation — the `pg_advisory_xact_lock` inside `createBehaviorEventRun` —
 * NOT in `findMatchingBehaviorActivations`. The lookup is an unlocked SELECT,
 * so two concurrent deliveries would both read "no recent activation" and both
 * fire. `debounces two concurrent deliveries` below is the regression test for
 * that; it fails against a cooldown evaluated during the match.
 *
 * WHY ONLY THE EVENT PATH: a schedule already spaces its own firings — cron IS
 * the operator's cadence control — so a cooldown there is redundant. Applying
 * this debounce in the event activation path to a scheduled firing would also
 * bypass the scheduler's `next_run_at` advancement and leave the cursor due.
 * Event activations have no cursor to strand: suppressing one simply means that
 * event does not fire this Behavior.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	findMatchingBehaviorActivations,
	queueBehaviorActivations,
} from "../../../behaviors/activation";
import {
	claimBehaviorCooldown,
	claimBehaviorCooldownStandalone,
	lockBehaviorForActivation,
} from "../../../behaviors/cooldown";
import type { DbClient } from "../../../db/client";
import type { Env } from "../../../index";
import { createBehaviorEventRun } from "../../../runs/queue-service";
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
	options?: { reuse?: Workspace; activeRun?: "queue" | "coalesce" },
): Promise<Fixture & { workspace: Workspace }> {
	const sql = getTestDb();
	const slug = `cooldown-${++counter}`;

	let workspace: Workspace;
	if (options?.reuse) {
		workspace = options.reuse;
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
					active_run: options?.activeRun ?? "coalesce",
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
    SELECT min_cooldown_seconds FROM behaviors WHERE id = ${behaviorId}
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

async function priorActivation(
	fixture: Fixture,
	secondsAgo: number,
): Promise<void> {
	const sql = getTestDb();
	await sql`
    UPDATE behaviors
    SET last_event_activation_at = now() - make_interval(secs => ${secondsAgo})
    WHERE id = ${fixture.behaviorId}
  `;
}

async function match(fixture: Fixture) {
	const found = await findMatchingBehaviorActivations(fixture.organizationId, {
		...fixture.signal,
		delivery_id: `event:cooldown:${++counter}`,
	});
	const activation = found.find(
		(candidate) => candidate.behaviorId === fixture.behaviorId,
	);
	if (!activation) throw new Error("Behavior did not match its own signal");
	return activation;
}

async function activate(fixture: Fixture): Promise<"queued" | "suppressed"> {
	const activation = await match(fixture);
	const results = await queueBehaviorActivations({
		matches: [activation],
		signal: {
			...fixture.signal,
			delivery_id: `event:cooldown:${++counter}`,
		},
	});
	return results.length > 0 ? "queued" : "suppressed";
}

async function behaviorRunCount(fixture: Fixture): Promise<number> {
	const sql = getTestDb();
	const [row] = await sql`
    SELECT count(*)::int AS n
    FROM runs
    WHERE behavior_id = ${fixture.behaviorId} AND run_type = 'behavior'
  `;
	return Number(row.n);
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
		await priorActivation(fixture, 60);

		expect(await activate(fixture)).toBe("suppressed");
		expect(await behaviorRunCount(fixture)).toBe(0);
	});

	it("allows an activation once the cooldown has elapsed", async () => {
		const fixture = await behaviorWithCooldown(1800);
		await priorActivation(fixture, 7200);

		expect(await activate(fixture)).toBe("queued");
		expect(await behaviorRunCount(fixture)).toBe(1);
	});

	it("allows the first activation when the Behavior has never run", async () => {
		const fixture = await behaviorWithCooldown(1800);

		expect(await activate(fixture)).toBe("queued");
	});

	it("does not debounce at all when the cooldown is 0 (the default)", async () => {
		const fixture = await behaviorWithCooldown(0);
		await priorActivation(fixture, 1);

		expect(await activate(fixture)).toBe("queued");
	});

	it("consumes the window on the activation itself, not on run completion", async () => {
		// A burst that starts a run and immediately re-fires must be debounced by
		// the run it just started. `behaviors.last_fired_at` is stamped when a run
		// reaches a TERMINAL state, so a cooldown built on it would only take
		// effect after the first run happened to finish — hence the dedicated
		// dispatch-time cursor. `active_run: "queue"` so the second signal is
		// judged by the cooldown rather than folded into the pending run.
		const fixture = await behaviorWithCooldown(1800, { activeRun: "queue" });

		expect(await activate(fixture)).toBe("queued");
		expect(await activate(fixture)).toBe("suppressed");
		expect(await behaviorRunCount(fixture)).toBe(1);
	});

	it("debounces two concurrent deliveries, not just sequential ones", async () => {
		// With the check in `findMatchingBehaviorActivations` both deliveries pass
		// the unlocked SELECT before either run exists, and two runs are created.
		// The claim only holds when it happens under the advisory lock that
		// already serializes `createBehaviorEventRun`.
		// `active_run: "queue"`, not the fixture default: a coalescing trigger
		// folds the second signal into the pending run and correctly never
		// reaches the cooldown, which would mask the race this test exists for.
		const fixture = await behaviorWithCooldown(1800, { activeRun: "queue" });
		const activation = await match(fixture);

		const settled = await Promise.all(
			[1, 2].map((n) =>
				createBehaviorEventRun({
					organizationId: fixture.organizationId,
					behaviorId: fixture.behaviorId,
					agentId: fixture.workspace.agentId,
					trigger: activation.trigger,
					signal: {
						...fixture.signal,
						// Distinct delivery ids: this must be debounced by the cooldown,
						// not incidentally by the delivery-id dedupe.
						delivery_id: `event:concurrent:${fixture.behaviorId}:${n}`,
					},
				}),
			),
		);

		const dispositions = settled.map((result) => result.disposition).sort();
		expect(dispositions).toEqual(["cooldown", "queued"]);
		expect(await behaviorRunCount(fixture)).toBe(1);
	});

	it("scopes the cooldown to one Behavior, not the whole connection", async () => {
		const cooling = await behaviorWithCooldown(1800);
		// The sibling must ALSO have a non-zero cooldown, or it short-circuits on
		// `min_cooldown_seconds = 0` and never reaches the scoping predicate —
		// which would let a cooldown that ignores the Behavior id pass unnoticed
		// (caught by mutation testing: a zero-cooldown sibling misses it).
		const sibling = await behaviorWithCooldown(1800, {
			reuse: cooling.workspace,
		});
		await priorActivation(cooling, 60);

		expect(await activate(cooling)).toBe("suppressed");
		expect(await activate(sibling)).toBe("queued");
	});

	it("does not consume the window when a signal coalesces into a pending run", async () => {
		// Coalescing folds a signal into a run that is already pending — the
		// Behavior does not start again, so it must not count against the
		// operator's cooldown or a busy trigger would starve itself.
		const fixture = await behaviorWithCooldown(1800);
		const activation = await match(fixture);
		const queue = (deliveryId: string) =>
			createBehaviorEventRun({
				organizationId: fixture.organizationId,
				behaviorId: fixture.behaviorId,
				agentId: fixture.workspace.agentId,
				trigger: activation.trigger,
				signal: { ...fixture.signal, delivery_id: deliveryId },
			});

		expect((await queue("event:coalesce:1")).disposition).toBe("queued");
		const [claimed] = await getTestDb()`
			SELECT last_event_activation_at
			FROM behaviors
			WHERE id = ${fixture.behaviorId}
		`;
		expect((await queue("event:coalesce:2")).disposition).toBe("coalesced");
		expect(await behaviorRunCount(fixture)).toBe(1);
		const [afterCoalesce] = await getTestDb()`
			SELECT last_event_activation_at
			FROM behaviors
			WHERE id = ${fixture.behaviorId}
		`;
		expect(afterCoalesce.last_event_activation_at).toEqual(
			claimed.last_event_activation_at,
		);
	});

	it("measures the cooldown at claim time, not transaction start", async () => {
		const fixture = await behaviorWithCooldown(1);
		const sql = getTestDb();

		await sql.begin(async (tx) => {
			await lockBehaviorForActivation(tx, fixture.behaviorId);
			await tx`
				UPDATE behaviors
				SET last_event_activation_at = now()
				WHERE id = ${fixture.behaviorId}
			`;
			await tx`SELECT pg_sleep(1.1)`;
			expect(await claimBehaviorCooldown(tx, fixture.behaviorId)).toBe(true);
		});
	});

	describe("the cursor the reply_to_source path shares", () => {
		it("is consumed by a standalone claim, as the chat bridge makes it", async () => {
			// Reply targets are handed to the chat transport and never write a
			// `behavior` run row, so a cooldown expressed over `runs` is a silent
			// no-op for them. Both paths claim `last_event_activation_at`, so the
			// operator gets one predicate regardless of a Behavior's output mode.
			const fixture = await behaviorWithCooldown(1800);

			expect(await claimBehaviorCooldownStandalone(fixture.behaviorId)).toBe(
				true,
			);
			expect(await claimBehaviorCooldownStandalone(fixture.behaviorId)).toBe(
				false,
			);
		});

		it("does not consume the cursor at the 0 default", async () => {
			const fixture = await behaviorWithCooldown(0);
			const activation = await match(fixture);

			expect(activation.minCooldownSeconds).toBe(0);
			expect(await claimBehaviorCooldownStandalone(fixture.behaviorId)).toBe(
				true,
			);
			expect(await claimBehaviorCooldownStandalone(fixture.behaviorId)).toBe(
				true,
			);
			const [row] = await getTestDb()`
				SELECT last_event_activation_at
				FROM behaviors
				WHERE id = ${fixture.behaviorId}
			`;
			expect(row.last_event_activation_at).toBeNull();
		});

		it("suppresses a reply when a background activation just consumed the window", async () => {
			// One Behavior, one window: a background firing must debounce a reply
			// firing and vice versa, or a mixed-trigger Behavior would get two
			// independent budgets.
			const fixture = await behaviorWithCooldown(1800);

			expect(await activate(fixture)).toBe("queued");
			expect(await claimBehaviorCooldownStandalone(fixture.behaviorId)).toBe(
				false,
			);
		});
	});

	it("suppresses an activation for a Behavior that no longer exists", async () => {
		const fixture = await behaviorWithCooldown(1800);
		const sql = getTestDb();
		await sql`DELETE FROM behaviors WHERE id = ${fixture.behaviorId}`;

		expect(await claimBehaviorCooldownStandalone(fixture.behaviorId)).toBe(
			false,
		);
	});

	it("propagates a cooldown claim failure instead of reporting suppression", async () => {
		const error = new Error("cooldown database unavailable");
		const unavailableDb = {
			begin: async () => {
				throw error;
			},
		} as unknown as DbClient;

		await expect(
			claimBehaviorCooldownStandalone(123, unavailableDb),
		).rejects.toBe(error);
	});
});
