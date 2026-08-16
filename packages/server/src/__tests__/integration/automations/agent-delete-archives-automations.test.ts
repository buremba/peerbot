import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { manageAutomations } from "../../../tools/admin/manage_automations";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestAgent,
	createTestConnection,
	seedOwnerContext,
} from "../../setup/test-fixtures";

describe("agent delete archives its Automations", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	/**
	 * The legacy agent_channel_bindings table unlinked channels through an FK
	 * cascade when an agent was deleted. automations has no FK on agent_id, so
	 * the DB trigger must archive the deleted agent's Automations — otherwise
	 * chat routing keeps resolving a nonexistent agent forever.
	 */
	it("archives active Automations when the owning agent row is deleted", async () => {
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
			const result = await manageAutomations(
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
			if (result.action !== "create" || !("automation_id" in result)) {
				throw new Error("Automation creation did not complete");
			}
			return Number(result.automation_id);
		};
		const doomedAutomation = await create(agent.agentId, "doomed-chat-link");
		const survivorAutomation = await create(
			survivor.agentId,
			"survivor-chat-link"
		);

		const sql = getTestDb();
		await sql`DELETE FROM agents WHERE id = ${agent.agentId}`;

		const rows = await sql`
			SELECT id, status FROM automations
			WHERE id IN (${doomedAutomation}, ${survivorAutomation})
			ORDER BY id ASC
		`;
		const byId = new Map(
			rows.map((row) => [Number(row.id), String(row.status)])
		);
		expect(byId.get(doomedAutomation)).toBe("archived");
		expect(byId.get(survivorAutomation)).toBe("active");
	});

	it("does not archive Automations in another org that share the same agent id", async () => {
		// agents PK is (organization_id, id). Two orgs can hold the same agent
		// string id; the delete trigger must not cross the org fence.
		const a = await seedOwnerContext();
		const b = await seedOwnerContext();
		const sharedAgentId = "shared-agent-id-cross-org";
		const agentA = await createTestAgent({
			organizationId: a.org.id,
			ownerUserId: a.user.id,
			agentId: sharedAgentId,
		});
		const agentB = await createTestAgent({
			organizationId: b.org.id,
			ownerUserId: b.user.id,
			agentId: sharedAgentId,
		});
		expect(agentA.agentId).toBe(sharedAgentId);
		expect(agentB.agentId).toBe(sharedAgentId);

		const connA = await createTestConnection({
			organization_id: a.org.id,
			connector_key: "slack",
			created_by: a.user.id,
		});
		const connB = await createTestConnection({
			organization_id: b.org.id,
			connector_key: "slack",
			created_by: b.user.id,
		});

		const create = async (
			ctx: typeof a.ctx,
			agentId: string,
			connectionId: number,
			slug: string,
		) => {
			const result = await manageAutomations(
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
							connection_id: connectionId,
							event_types: ["message.created"],
							match: { channel_id: "C123" },
							execution: "turn",
							output: "reply_to_source",
						},
					],
				},
				{} as Env,
				ctx,
			);
			if (result.action !== "create" || !("automation_id" in result)) {
				throw new Error("Automation creation did not complete");
			}
			return Number(result.automation_id);
		};

		const automationA = await create(
			a.ctx,
			sharedAgentId,
			connA.id,
			"org-a-chat-link",
		);
		const automationB = await create(
			b.ctx,
			sharedAgentId,
			connB.id,
			"org-b-chat-link",
		);

		const sql = getTestDb();
		await sql`
			DELETE FROM agents
			WHERE organization_id = ${a.org.id}
			  AND id = ${sharedAgentId}
		`;

		const rows = await sql`
			SELECT id, organization_id, status FROM automations
			WHERE id IN (${automationA}, ${automationB})
			ORDER BY id ASC
		`;
		const byId = new Map(
			rows.map((row) => [
				Number(row.id),
				{
					org: String(row.organization_id),
					status: String(row.status),
				},
			]),
		);
		expect(byId.get(automationA)).toEqual({
			org: a.org.id,
			status: "archived",
		});
		expect(byId.get(automationB)).toEqual({
			org: b.org.id,
			status: "active",
		});
	});
});
