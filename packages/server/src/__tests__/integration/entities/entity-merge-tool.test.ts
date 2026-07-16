/**
 * manage_entity `merge` action — the tool surface a watcher's agent (or an admin)
 * calls to fuse two entities. Covers the gate (admin/owner only), the org fence
 * (no cross-tenant / deleted target), and the happy path delegating to applyMerge.
 * The fusion mechanics themselves are proven in events/entity-merge.test.ts.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { manageEntity } from "../../../tools/admin/manage_entity";
import { manageOperations } from "../../../tools/admin/manage_operations";
import type { ToolContext } from "../../../tools/registry";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestConnection,
	createTestEntity,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const env = {} as Env;

function ctx(orgId: string, userId: string, memberRole: string): ToolContext {
	// Full MCP scopes so the action-router's scope gate passes; the test asserts
	// the ROLE gate (admin/owner) inside the handler, not the scope tier.
	return {
		organizationId: orgId,
		userId,
		memberRole,
		scopes: ["mcp:read", "mcp:write", "mcp:admin"],
	} as ToolContext;
}

describe("manage_entity merge action", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
	});

	async function twoEntities(orgId: string, userId: string) {
		const winner = await createTestEntity({
			name: "Winner",
			entity_type: "person",
			organization_id: orgId,
			created_by: userId,
		});
		const loser = await createTestEntity({
			name: "Loser",
			entity_type: "person",
			organization_id: orgId,
			created_by: userId,
		});
		return { winner, loser };
	}

	it("an owner merges the loser into the winner (loser tombstoned + forwarded)", async () => {
		const org = await createTestOrganization({ name: "Merge Tool Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);

		const res = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			ctx(org.id, user.id, "owner"),
		)) as {
			action: string;
			success: boolean;
			winner_entity_id: number;
			loser_entity_id: number;
		};

		expect(res.action).toBe("merge");
		expect(res.success).toBe(true);
		expect(res.winner_entity_id).toBe(winner.id);
		expect(res.loser_entity_id).toBe(loser.id);

		const sql = getTestDb();
		const [row] = (await sql`
      SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}
    `) as Array<{ merged_into: number | null; deleted_at: string | null }>;
		expect(Number(row.merged_into)).toBe(winner.id);
		expect(row.deleted_at).not.toBeNull();
	});

	it("rejects a non-admin member (403)", async () => {
		const org = await createTestOrganization({ name: "Gate Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "member");
		const { winner, loser } = await twoEntities(org.id, user.id);

		await expect(
			manageEntity(
				{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
				env,
				ctx(org.id, user.id, "member"),
			),
		).rejects.toThrow(/admin or owner/i);
	});

	it("rejects a winner from another org (org fence, 404)", async () => {
		const orgA = await createTestOrganization({ name: "Org A" });
		const orgB = await createTestOrganization({ name: "Org B" });
		const userA = await createTestUser();
		const userB = await createTestUser();
		await addUserToOrganization(userA.id, orgA.id, "owner");
		await addUserToOrganization(userB.id, orgB.id, "owner");
		const loser = await createTestEntity({
			name: "A-loser",
			entity_type: "person",
			organization_id: orgA.id,
			created_by: userA.id,
		});
		const foreignWinner = await createTestEntity({
			name: "B-winner",
			entity_type: "person",
			organization_id: orgB.id,
			created_by: userB.id,
		});

		await expect(
			manageEntity(
				{
					action: "merge",
					entity_id: loser.id,
					winner_entity_id: foreignWinner.id,
				},
				env,
				ctx(orgA.id, userA.id, "owner"),
			),
		).rejects.toThrow(/not found in this workspace/i);
	});

	it("queues a watcher merge for human approval and applies it only after approval", async () => {
		const org = await createTestOrganization({
			name: "Watcher Merge Approval Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
      INSERT INTO watchers
        (id, organization_id, agent_id, created_by, watcher_group_id, name,
         status, notification_channel, notification_priority, min_cooldown_seconds,
         created_at, updated_at)
      VALUES
        (6001, ${org.id}, 'personal-agent', ${user.id}, 6001, 'Duplicate merge',
         'active', 'canvas', 'normal', 0, now(), now())
    `;

		const watcherCtx = {
			...ctx(org.id, user.id, "owner"),
			userId: null,
			agentId: "personal-agent",
			actingWatcherId: 6001,
		} as ToolContext;
		const queued = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			watcherCtx,
		)) as unknown as { approval_queued: boolean; approval_run_id: number };

		expect(queued.approval_queued).toBe(true);
		const [before] =
			await sql`SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}`;
		expect(before.merged_into).toBeNull();
		expect(before.deleted_at).toBeNull();
		const [pending] = await sql`
      SELECT watcher_id, approval_status, action_input FROM runs WHERE id = ${queued.approval_run_id}
    `;
		expect(Number(pending.watcher_id)).toBe(6001);
		expect(pending.approval_status).toBe("pending");
		expect((pending.action_input as Record<string, unknown>).operation).toBe(
			"merge",
		);

		const approved = await manageOperations(
			{ action: "approve", run_id: queued.approval_run_id },
			env,
			ctx(org.id, user.id, "owner"),
		);
		expect("approved" in approved && approved.approved).toBe(true);

		const [after] =
			await sql`SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}`;
		expect(Number(after.merged_into)).toBe(winner.id);
		expect(after.deleted_at).not.toBeNull();
	});

	it("queues one atomic watcher approval for a duplicate group", async () => {
		const org = await createTestOrganization({
			name: "Group Merge Approval Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const secondLoser = await createTestEntity({
			name: "Second loser",
			entity_type: "person",
			organization_id: org.id,
			created_by: user.id,
		});
		const sql = getTestDb();
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: "google-contacts",
			display_name: "Personal Google Contacts",
			created_by: user.id,
			createDefaultFeed: false,
		});
		await sql`
      INSERT INTO entity_identities
        (organization_id, entity_id, namespace, identifier, source_connector, connection_id)
      VALUES
        (${org.id}, ${loser.id}, 'email', 'duplicate@example.com',
         'connector:google-contacts', ${connection.id})
    `;
		await sql`
      INSERT INTO watchers
        (id, organization_id, agent_id, created_by, watcher_group_id, name,
         status, notification_channel, notification_priority, min_cooldown_seconds,
         created_at, updated_at)
      VALUES
        (6003, ${org.id}, 'personal-agent', ${user.id}, 6003, 'Group duplicate merge',
         'active', 'canvas', 'normal', 0, now(), now())
    `;

		const queued = (await manageEntity(
			{
				action: "merge",
				duplicate_entity_ids: [loser.id, secondLoser.id],
				winner_entity_id: winner.id,
			},
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
				actingWatcherId: 6003,
			} as ToolContext,
		)) as unknown as { approval_run_id: number };

		const [pending] = await sql`
      SELECT action_input FROM runs WHERE id = ${queued.approval_run_id}
    `;
		expect(pending.action_input).toMatchObject({
			operation: "merge",
			entity_ids: [loser.id, secondLoser.id],
			winner_entity_id: winner.id,
		});
		const [approvalEvent] = await sql`
      SELECT metadata FROM current_event_records
      WHERE run_id = ${queued.approval_run_id} AND interaction_status = 'pending'
    `;
		const current = (approvalEvent.metadata as Record<string, unknown>)
			.current as {
			duplicates: Array<{
				href: string;
				identities: Array<Record<string, unknown>>;
			}>;
		};
		expect(current.duplicates[0]?.href).toContain("/person/");
		expect(current.duplicates[0]?.identities[0]).toMatchObject({
			identifier: "duplicate@example.com",
			connection_id: connection.id,
			connection_name: "Personal Google Contacts",
			connector_key: "google-contacts",
		});
		expect(current.duplicates[0]?.identities[0]?.connection_href).toContain(
			`/connectors/google-contacts/${connection.id}`,
		);

		const approved = await manageOperations(
			{ action: "approve", run_id: queued.approval_run_id },
			env,
			ctx(org.id, user.id, "owner"),
		);
		expect("approved" in approved && approved.approved).toBe(true);
		const rows = await sql`
      SELECT id, merged_into, deleted_at
      FROM entities
      WHERE id IN (${loser.id}, ${secondLoser.id})
      ORDER BY id
    `;
		expect(rows).toHaveLength(2);
		expect(rows.every((row) => Number(row.merged_into) === winner.id)).toBe(
			true,
		);
		expect(rows.every((row) => row.deleted_at !== null)).toBe(true);
	});

	it("rolls back the whole duplicate group when one member is stale", async () => {
		const org = await createTestOrganization({ name: "Stale Group Merge Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const staleLoser = await createTestEntity({
			name: "Stale loser",
			entity_type: "person",
			organization_id: org.id,
			created_by: user.id,
		});
		const sql = getTestDb();
		await sql`
      INSERT INTO watchers
        (id, organization_id, agent_id, created_by, watcher_group_id, name,
         status, notification_channel, notification_priority, min_cooldown_seconds,
         created_at, updated_at)
      VALUES
        (6004, ${org.id}, 'personal-agent', ${user.id}, 6004, 'Stale group merge',
         'active', 'canvas', 'normal', 0, now(), now())
    `;
		const queued = (await manageEntity(
			{
				action: "merge",
				duplicate_entity_ids: [loser.id, staleLoser.id],
				winner_entity_id: winner.id,
			},
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
				actingWatcherId: 6004,
			} as ToolContext,
		)) as unknown as { approval_run_id: number };

		await sql`UPDATE entities SET deleted_at = now() WHERE id = ${staleLoser.id}`;
		const approved = await manageOperations(
			{ action: "approve", run_id: queued.approval_run_id },
			env,
			ctx(org.id, user.id, "owner"),
		);
		expect("approved" in approved && approved.approved).toBe(false);
		const [first] = await sql`
      SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}
    `;
		expect(first.merged_into).toBeNull();
		expect(first.deleted_at).toBeNull();
	});

	it("does not apply an approved watcher merge when the loser was deleted after proposal", async () => {
		const org = await createTestOrganization({ name: "Stale Merge Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
      INSERT INTO watchers
        (id, organization_id, agent_id, created_by, watcher_group_id, name,
         status, notification_channel, notification_priority, min_cooldown_seconds,
         created_at, updated_at)
      VALUES
        (6002, ${org.id}, 'personal-agent', ${user.id}, 6002, 'Stale duplicate merge',
         'active', 'canvas', 'normal', 0, now(), now())
    `;

		const queued = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
				actingWatcherId: 6002,
			} as ToolContext,
		)) as unknown as { approval_run_id: number };

		await sql`UPDATE entities SET deleted_at = now() WHERE id = ${loser.id}`;
		const approved = await manageOperations(
			{ action: "approve", run_id: queued.approval_run_id },
			env,
			ctx(org.id, user.id, "owner"),
		);

		expect("approved" in approved && approved.approved).toBe(false);
		const [after] = await sql`
      SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}
    `;
		expect(after.merged_into).toBeNull();
		expect(after.deleted_at).not.toBeNull();
	});
});
