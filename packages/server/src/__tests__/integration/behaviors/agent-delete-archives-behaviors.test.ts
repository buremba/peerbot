import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { manageBehaviors } from "../../../tools/admin/manage_behaviors";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestAgent,
	createTestConnection,
	seedOwnerContext,
} from "../../setup/test-fixtures";

describe("agent delete archives its Behaviors", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	/**
	 * The legacy agent_channel_bindings table unlinked channels through an FK
	 * cascade when an agent was deleted. watchers has no FK on agent_id, so
	 * the DB trigger must archive the deleted agent's Behaviors — otherwise
	 * chat routing keeps resolving a nonexistent agent forever.
	 */
	it("archives active Behaviors when the owning agent row is deleted", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const survivor = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: "slack",
			created_by: user.id,
		});
		const create = async (agentId: string, slug: string) => {
			const result = await manageBehaviors(
				{
					action: "create",
					slug,
					name: slug,
					prompt: "Reply in the linked channel.",
					agent_id: agentId,
					triggers: [
						{
							kind: "event",
							connector_key: "slack",
							connection_id: connection.id,
							event_types: ["message.created"],
							match: { channel_id: "C123" },
							execution: "turn",
							output: "reply_to_source",
						},
					],
				},
				{} as Env,
				ctx
			);
			if (result.action !== "create" || !("watcher_id" in result)) {
				throw new Error("Behavior creation did not complete");
			}
			return Number(result.watcher_id);
		};
		const doomedBehavior = await create(agent.agentId, "doomed-chat-link");
		const survivorBehavior = await create(
			survivor.agentId,
			"survivor-chat-link"
		);

		const sql = getTestDb();
		await sql`DELETE FROM agents WHERE id = ${agent.agentId}`;

		const rows = await sql`
			SELECT id, status FROM watchers
			WHERE id IN (${doomedBehavior}, ${survivorBehavior})
			ORDER BY id ASC
		`;
		const byId = new Map(
			rows.map((row) => [Number(row.id), String(row.status)])
		);
		expect(byId.get(doomedBehavior)).toBe("archived");
		expect(byId.get(survivorBehavior)).toBe("active");
	});
});
