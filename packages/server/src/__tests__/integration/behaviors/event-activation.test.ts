import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activateBehaviorSignal } from "../../../behaviors/activation";
import type { Env } from "../../../index";
import { manageBehaviors } from "../../../tools/admin/manage_behaviors";
import { getWatcher } from "../../../tools/get_watchers";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestAgent,
	createTestConnection,
	seedOwnerContext,
} from "../../setup/test-fixtures";

describe("Behavior connector-event activation", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("round-trips triggers and queues each unique delivery without an LLM on duplicates", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: "github",
			created_by: user.id,
		});
		const trigger = {
			kind: "event" as const,
			connector_key: "github",
			connection_id: connection.id,
			event_types: ["pull_request.created"],
			match: { repository: "lobu-ai/lobu" },
			execution: "turn" as const,
			active_run: "queue" as const,
			output: "silent" as const,
			skip_if_unchanged: true,
		};
		const created = await manageBehaviors(
			{
				action: "create",
				slug: "github-pr-created",
				name: "GitHub PR created",
				prompt: "Review the incoming pull request.",
				agent_id: agent.agentId,
				triggers: [trigger],
			},
			{} as Env,
			ctx,
		);
		if (created.action !== "create" || !("watcher_id" in created)) {
			throw new Error("Behavior creation did not complete");
		}
		const behaviorId = Number(created.watcher_id);

		const signal = {
			connector_key: "github",
			connection_id: connection.id,
			resource_type: "pull_request",
			resource_ref: "github:pull_request:lobu-ai/lobu#208",
			event_type: "pull_request.created",
			delivery_id: "event:91",
			label: "PR 208",
			input_text: "Review PR 208",
			attributes: { repository: "lobu-ai/lobu", pull_number: 208 },
		};
		const first = await activateBehaviorSignal({
			organizationId: org.id,
			signal,
		});
		const duplicate = await activateBehaviorSignal({
			organizationId: org.id,
			signal,
		});
		const second = await activateBehaviorSignal({
			organizationId: org.id,
			signal: { ...signal, delivery_id: "event:92" },
		});

		expect(first).toMatchObject([
			{ behaviorId, created: true, disposition: "queued" },
		]);
		expect(duplicate).toMatchObject([
			{ behaviorId, created: false, disposition: "duplicate" },
		]);
		expect(second).toMatchObject([
			{ behaviorId, created: true, disposition: "queued" },
		]);

		const sql = getTestDb();
		const [stored] = await sql`
			SELECT triggers FROM watchers WHERE id = ${behaviorId}
		`;
		expect(stored?.triggers).toEqual([trigger]);
		const detail = await getWatcher(
			{ watcher_id: String(behaviorId) },
			{} as Env,
			ctx,
		);
		expect(detail.watcher?.triggers).toEqual([trigger]);
		const runs = await sql`
			SELECT approved_input
			FROM runs
			WHERE watcher_id = ${behaviorId}
			ORDER BY id ASC
		`;
		expect(runs).toHaveLength(2);
		expect(runs[0]?.approved_input).toMatchObject({
			dispatch_source: "event",
			trigger_execution: "turn",
			delivery_ids: ["event:91"],
		});
	});

	it("coalesces waiting deliveries into one durable pending run", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: "github",
			created_by: user.id,
		});
		const created = await manageBehaviors(
			{
				action: "create",
				slug: "github-pr-window",
				name: "GitHub PR window",
				prompt: "Summarize changed pull requests.",
				agent_id: agent.agentId,
				triggers: [
					{
						kind: "event",
						connector_key: "github",
						connection_id: connection.id,
						event_types: ["pull_request.updated"],
						execution: "window",
						active_run: "coalesce",
						output: "silent",
						skip_if_unchanged: true,
					},
				],
			},
			{} as Env,
			ctx,
		);
		if (created.action !== "create" || !("watcher_id" in created)) {
			throw new Error("Behavior creation did not complete");
		}
		const behaviorId = Number(created.watcher_id);
		const baseSignal = {
			connector_key: "github",
			connection_id: connection.id,
			event_type: "pull_request.updated",
			label: "PR changed",
			input_text: "A pull request changed",
		};
		await activateBehaviorSignal({
			organizationId: org.id,
			signal: { ...baseSignal, delivery_id: "event:101" },
		});
		const coalesced = await activateBehaviorSignal({
			organizationId: org.id,
			signal: { ...baseSignal, delivery_id: "event:102" },
		});

		expect(coalesced).toMatchObject([
			{ behaviorId, created: false, disposition: "coalesced" },
		]);
		const sql = getTestDb();
		const runs = await sql`
			SELECT approved_input FROM runs WHERE watcher_id = ${behaviorId}
		`;
		expect(runs).toHaveLength(1);
		expect(runs[0]?.approved_input).toMatchObject({
			delivery_ids: ["event:101", "event:102"],
			trigger_execution: "window",
		});
	});

	it("rejects events and delivery modes the connector does not support", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: "github",
			created_by: user.id,
		});
		const create = (slug: string, trigger: Record<string, unknown>) =>
			manageBehaviors(
				{
					action: "create",
					slug,
					name: slug,
					prompt: "Handle the incoming event.",
					agent_id: agent.agentId,
					triggers: [
						{
							kind: "event",
							connector_key: "github",
							connection_id: connection.id,
							event_types: ["pull_request.created"],
							...trigger,
						},
					],
				},
				{} as Env,
				ctx,
			);

		await expect(
			create("unsupported-event", { event_types: ["pull_request.deleted"] }),
		).rejects.toThrow(
			"GitHub does not support Behavior event 'pull_request.deleted'",
		);
		await expect(
			create("unsupported-steering", { active_run: "steer" }),
		).rejects.toThrow(
			"GitHub event 'pull_request.created' does not support steering",
		);
		await expect(
			create("unsupported-source-reply", { output: "reply_to_source" }),
		).rejects.toThrow(
			"GitHub event 'pull_request.created' does not support replying to the source",
		);
	});
});
