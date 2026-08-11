import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	deriveConnectorActivationSignals,
	type ConnectorDeriveEventInput,
	type ConnectorDeriveFeedContext,
} from "../../../behaviors/connector-derived";
import { activateBehaviorSignal } from "../../../behaviors/activation";
import type { Env } from "../../../index";
import { manageBehaviors } from "../../../tools/admin/manage_behaviors";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestAgent,
	createTestConnection,
	seedOwnerContext,
} from "../../setup/test-fixtures";

describe("platform-derived connector activation", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("creates a trigger for a derived kind and queues a run when a new feed event lands", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: "x",
			slug: "xconn-derived",
			created_by: user.id,
		});

		// A timeline-listener trigger on the derived kind `tweet`, scoped to the
		// home feed via match. Creation proves the connector's behavior_events
		// catalog was derived from its eventKinds (X declares none by hand).
		const created = await manageBehaviors(
			{
				action: "create",
				slug: "x-home-listener",
				name: "X home listener",
				prompt: "Draft a reply worth making.",
				agent_id: agent.agentId,
				triggers: [
					{
						kind: "event",
						source: "connector",
						connector_key: "x",
						connection_id: connection.id,
						event_types: ["tweet"],
						match: { feed_key: "home_feed" },
						execution: "turn",
						active_run: "queue",
						output: "silent",
						skip_if_unchanged: true,
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

		const deriveContext: ConnectorDeriveFeedContext = {
			organizationId: org.id,
			connectorKey: "x",
			feedKey: "home_feed",
			feedCheckpointed: true,
			eventKinds: {
				tweet: { description: "A tweet from your home timeline" },
			},
		};
		const event: ConnectorDeriveEventInput = {
			connectionId: connection.id,
			feedId: 1,
			runId: 100,
			originId: "2083959735481716957",
			kind: "tweet",
			title: "someone: hello",
			payloadText: "hello from the home timeline",
			sourceUrl: "https://x.com/someone/status/2083959735481716957",
			occurredAt: "2026-08-11T10:00:00.000Z",
			metadata: { author_handle: "someone" },
		};

		const [signal] = deriveConnectorActivationSignals(
			deriveContext,
			event,
			"inserted",
			123,
		);
		expect(signal).toBeDefined();
		const activations = await activateBehaviorSignal({
			organizationId: org.id,
			signal,
		});
		expect(activations).toMatchObject([
			{ behaviorId, created: true, disposition: "queued" },
		]);

		const sql = getTestDb();
		const runs = await sql`
			SELECT approved_input
			FROM runs
			WHERE watcher_id = ${behaviorId}
			ORDER BY id ASC
		`;
		expect(runs).toHaveLength(1);
		expect(runs[0]?.approved_input).toMatchObject({
			dispatch_source: "event",
			trigger_execution: "turn",
			delivery_ids: ["sync:100:event:123:derived"],
		});
	});

	it("queues nothing while the feed has no prior successful sync (backfill)", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: "x",
			slug: "xconn-coldstart",
			created_by: user.id,
		});
		await manageBehaviors(
			{
				action: "create",
				slug: "x-cold-listener",
				name: "X cold listener",
				prompt: "Draft a reply worth making.",
				agent_id: agent.agentId,
				triggers: [
					{
						kind: "event",
						source: "connector",
						connector_key: "x",
						connection_id: connection.id,
						event_types: ["tweet"],
						execution: "turn",
						active_run: "queue",
						output: "silent",
						skip_if_unchanged: true,
					},
				],
			},
			{} as Env,
			ctx,
		);

		const coldStart: ConnectorDeriveFeedContext = {
			organizationId: org.id,
			connectorKey: "x",
			feedKey: "home_feed",
			feedCheckpointed: false,
			eventKinds: { tweet: {} },
		};
		const event: ConnectorDeriveEventInput = {
			connectionId: connection.id,
			feedId: 1,
			runId: 100,
			originId: "1",
			kind: "tweet",
			title: null,
			payloadText: "hello",
			sourceUrl: null,
			occurredAt: new Date(),
			metadata: undefined,
		};
		const signals = deriveConnectorActivationSignals(
			coldStart,
			event,
			"inserted",
			1,
		);
		expect(signals).toEqual([]);
	});
});
