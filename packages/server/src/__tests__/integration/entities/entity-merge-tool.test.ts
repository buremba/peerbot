/**
 * manage_entity `merge` action — the tool surface a watcher's agent (or an admin)
 * calls to fuse two entities. Covers the gate (admin/owner only), the org fence
 * (no cross-tenant / deleted target), and the happy path delegating to applyMerge.
 * The fusion mechanics themselves are proven in events/entity-merge.test.ts.
 */

import postgres from "postgres";
import { beforeEach, describe, expect, it } from "vitest";
import { PROD_PG_VALUE_OPTIONS } from "../../../db/client";
import { assessEntityResolution } from "../../../entity-resolution/policy";
import { assertResolutionFingerprintCurrent } from "../../../entity-resolution/staleness";
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

	it("rejects a cross-type merge before queuing approval", async () => {
		const org = await createTestOrganization({ name: "Cross Type Tool Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const person = await createTestEntity({
			name: "Person",
			entity_type: "person",
			organization_id: org.id,
			created_by: user.id,
		});
		const company = await createTestEntity({
			name: "Company",
			entity_type: "company",
			organization_id: org.id,
			created_by: user.id,
		});

		await expect(
			manageEntity(
				{
					action: "merge",
					entity_id: person.id,
					winner_entity_id: company.id,
				},
				env,
				ctx(org.id, user.id, "owner"),
			),
		).rejects.toThrow(/same entity type/i);
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
		const [approvalEvent] = await sql`
			SELECT title FROM current_event_records
			WHERE run_id = ${queued.approval_run_id} AND interaction_status = 'pending'
		`;
		expect(approvalEvent.title).toBe(
			"Merge Loser into Winner — pending approval",
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
		const [completedRun] = await sql`
			SELECT status, approval_status FROM runs WHERE id = ${queued.approval_run_id}
		`;
		expect(completedRun).toMatchObject({
			status: "completed",
			approval_status: "approved",
		});
		const [completedEvent] = await sql`
			SELECT interaction_status FROM current_event_records
			WHERE run_id = ${queued.approval_run_id}
		`;
		expect(completedEvent.interaction_status).toBe("completed");
	});

	it("queues review evidence for a phone shared only through entity_identities", async () => {
		const org = await createTestOrganization({ name: "Identity Evidence Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier)
      VALUES
        (${org.id}, ${winner.id}, 'phone', '+44 7700 900 123'),
        (${org.id}, ${loser.id}, 'phone', '447700900123'),
        (${org.id}, ${loser.id}, 'wa_jid', '447700900123@s.whatsapp.net')
    `;

		const queued = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
			} as ToolContext,
		)) as unknown as {
			approval_queued: boolean;
			resolution: {
				decision: string;
				evidence: Array<{ kind: string; identifier: string }>;
			};
		};

		expect(queued.approval_queued).toBe(true);
		expect(queued.resolution.decision).toBe("review");
		expect(queued.resolution.evidence).toContainEqual({
			kind: "phone",
			identifier: "447700900123",
		});
	});

	it("records the agent session that proposed the merge, not an orphan run", async () => {
		// Prod regression: 18 of 24 pending proposals (runs 702088–702105) were
		// orphans — watcher_id null, created_by_user_id null, no initiator — because
		// an MCP session populates none of actingWatcherId/actingRunId, and the
		// writers only ever read those. The identity was on the context all along.
		const org = await createTestOrganization({ name: "Initiator Agent Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();

		const queued = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			{
				...ctx(org.id, user.id, "owner"),
				agentId: "personal-agent",
				clientId: "claude-ai",
				sourceContext: { platform: "mcp", conversationId: "conv-abc" },
			} as ToolContext,
		)) as unknown as { approval_queued: boolean; approval_run_id: number };

		expect(queued.approval_queued).toBe(true);
		const [run] = await sql`
			SELECT initiator_kind, initiator_ref, created_by_user_id, watcher_id
			FROM runs WHERE id = ${queued.approval_run_id}
		`;
		expect(run.initiator_kind).toBe("agent_session");
		expect(run.initiator_ref).toMatchObject({
			agent_id: "personal-agent",
			client_id: "claude-ai",
			conversation_id: "conv-abc",
		});
		// The human whose session authorized the agent is recoverable, and this is
		// NOT a behavior — watcher_id must stay null rather than borrow one.
		expect(run.created_by_user_id).toBe(user.id);
		expect(run.watcher_id).toBeNull();
	});

	it("records a behavior initiator consistent with the legacy watcher columns", async () => {
		const org = await createTestOrganization({ name: "Initiator Behavior Org" });
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
        (6021, ${org.id}, 'personal-agent', ${user.id}, 6021, 'Initiator behavior',
         'active', 'canvas', 'normal', 0, now(), now())
    `;

		const queued = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
				actingWatcherId: 6021,
			} as ToolContext,
		)) as unknown as { approval_queued: boolean; approval_run_id: number };

		const [run] = await sql`
			SELECT initiator_kind, initiator_ref, watcher_id
			FROM runs WHERE id = ${queued.approval_run_id}
		`;
		expect(run.initiator_kind).toBe("behavior");
		// The new ref and the legacy column describe the same behavior — pinned so
		// the two provenance channels can never drift apart.
		expect((run.initiator_ref as { watcher_id: number }).watcher_id).toBe(6021);
		expect(Number(run.watcher_id)).toBe(6021);
	});

	it("does not let a caller-supplied behavior_source forge the initiator", async () => {
		// behavior_source stays as an authz SELF-restriction channel, but it is
		// caller input: an agent that tags a foreign behavior must still be recorded
		// as the agent session it actually is, or provenance becomes forgeable.
		const org = await createTestOrganization({ name: "Initiator Spoof Org" });
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
        (6022, ${org.id}, 'other-agent', ${user.id}, 6022, 'Someone elses behavior',
         'active', 'canvas', 'normal', 0, now(), now())
    `;

		const queued = (await manageEntity(
			{
				action: "merge",
				entity_id: loser.id,
				winner_entity_id: winner.id,
				behavior_source: { behavior_id: 6022, window_id: 1 },
			},
			env,
			{
				...ctx(org.id, user.id, "owner"),
				agentId: "personal-agent",
				clientId: "claude-ai",
			} as ToolContext,
		)) as unknown as { approval_run_id: number };

		const [run] = await sql`
			SELECT initiator_kind, initiator_ref FROM runs WHERE id = ${queued.approval_run_id}
		`;
		expect(run.initiator_kind).toBe("agent_session");
		expect((run.initiator_ref as { agent_id: string }).agent_id).toBe(
			"personal-agent",
		);
	});

	it("carries the proposer's rationale to the card without letting it prove the merge", async () => {
		const org = await createTestOrganization({ name: "Rationale Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();

		const agentCtx = {
			...ctx(org.id, user.id, "owner"),
			userId: null,
			agentId: "personal-agent",
		} as ToolContext;
		const queued = (await manageEntity(
			{
				action: "merge",
				entity_id: loser.id,
				winner_entity_id: winner.id,
				merge_rationale: "  Same phone digits; shell is their WhatsApp handle.  ",
			},
			env,
			agentCtx,
		)) as unknown as {
			approval_queued: boolean;
			approval_run_id: number;
			resolution: { decision: string; evidence: unknown[] };
		};

		// The rationale must not make the merge look proven: no shared email or
		// phone exists, so the decision stays review and the evidence stays empty.
		expect(queued.approval_queued).toBe(true);
		expect(queued.resolution.decision).toBe("review");
		expect(queued.resolution.evidence).toEqual([]);

		const [approvalEvent] = await sql`
			SELECT metadata FROM current_event_records
			WHERE run_id = ${queued.approval_run_id} AND interaction_status = 'pending'
		`;
		const metadata = approvalEvent.metadata as Record<string, unknown>;
		expect(metadata.proposer_rationale).toBe(
			"Same phone digits; shell is their WhatsApp handle.",
		);
		// The policy verdict is stored separately and is not the proposer's text.
		expect(metadata.reason).not.toBe(metadata.proposer_rationale);
		expect(String(metadata.reason)).toContain("needs your judgement");
	});

	it("auto-merges an exact configured email match without human approval", async () => {
		const org = await createTestOrganization({
			name: "Strict Email Merge Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
			UPDATE entity_types
			SET metadata_schema = ${sql.json({
				type: "object",
				properties: {
					email: { type: "string" },
					phone: { type: "string" },
				},
				"x-lobu-resolution": {
					rules: [
						{
							fields: ["email"],
							normalizer: "email",
							onMatch: "auto_merge",
						},
						{
							fields: ["phone"],
							normalizer: "phone",
							onMatch: "review",
						},
					],
				},
			})}
			WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${winner.id})
		`;
		await sql`
			UPDATE entities
			SET metadata = jsonb_build_object('email', 'Person@Example.com')
			WHERE id = ${winner.id}
		`;
		await sql`
			UPDATE entities
			SET metadata = jsonb_build_object('email', 'person@example.com')
			WHERE id = ${loser.id}
		`;
		await sql`
			INSERT INTO watchers
			  (id, organization_id, agent_id, created_by, watcher_group_id, name,
			   status, notification_channel, notification_priority, min_cooldown_seconds,
			   created_at, updated_at)
			VALUES
			  (6009, ${org.id}, 'personal-agent', ${user.id}, 6009,
			   'Strict duplicate resolution', 'active', 'canvas', 'normal', 0,
			   now(), now())
		`;
		const [watcherRun] = await sql<{ id: number }[]>`
			INSERT INTO runs
			  (run_type, status, organization_id, watcher_id, window_id,
			   approval_status, created_at, completed_at)
			VALUES
			  ('behavior', 'completed', ${org.id}, 6009, 7001, 'auto', now(), now())
			RETURNING id
		`;

		const result = (await manageEntity(
			{
				action: "merge",
				entity_id: loser.id,
				winner_entity_id: winner.id,
				merge_evidence: [{ kind: "email", identifier: "person@example.com" }],
			},
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
				actingWatcherId: 6009,
				actingWindowId: 7001,
				actingRunId: watcherRun.id,
			} as ToolContext,
		)) as unknown as {
			action: string;
			success: boolean;
			approval_queued?: boolean;
			resolution: { decision: string };
		};

		expect(result.success).toBe(true);
		expect(result.approval_queued).toBeUndefined();
		expect(result.resolution.decision).toBe("auto_merge");
		const [merged] = await sql`
			SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}
		`;
		expect(Number(merged.merged_into)).toBe(winner.id);
		expect(merged.deleted_at).not.toBeNull();
		const [operation] = await sql`
			SELECT decision, source_run_id, window_id, status
			FROM entity_merge_operations
			WHERE organization_id = ${org.id}
		`;
		expect(operation).toMatchObject({
			decision: "auto_merge",
			source_run_id: watcherRun.id,
			window_id: 7001,
			status: "active",
		});
	});

	it("discovers duplicate groups server-side from candidate IDs", async () => {
		const org = await createTestOrganization({
			name: "Duplicate Discovery Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
			UPDATE entity_types
			SET metadata_schema = ${sql.json({
				type: "object",
				"x-lobu-resolution": {
					rules: [
						{
							fields: ["email"],
							normalizer: "email",
							onMatch: "auto_merge",
						},
					],
				},
			})}
			WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${winner.id})
		`;
		await sql`
			UPDATE entities SET metadata = ${sql.json({
				email: "same@example.com",
				title: "Canonical",
			})} WHERE id = ${winner.id}
		`;
		await sql`
			UPDATE entities SET metadata = ${sql.json({
				email: " SAME@example.com ",
			})} WHERE id = ${loser.id}
		`;
		await sql`
			INSERT INTO watchers
			  (id, organization_id, agent_id, created_by, watcher_group_id, name,
			   status, notification_channel, notification_priority,
			   min_cooldown_seconds, created_at, updated_at)
			VALUES
			  (6010, ${org.id}, 'personal-agent', ${user.id}, 6010,
			   'Duplicate discovery', 'active', 'canvas', 'normal', 0, now(), now())
		`;

		const result = await manageEntity(
			{
				action: "resolve_duplicates",
				candidate_entity_ids: [winner.id, loser.id],
			},
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
				actingWatcherId: 6010,
			} as ToolContext,
		);
		expect(result).toMatchObject({
			action: "resolve_duplicates",
			candidates_scanned: 2,
			groups_found: 1,
			auto_merged: 1,
			approvals_queued: 0,
		});
		const [merged] = await sql`
			SELECT merged_into FROM entities WHERE id = ${loser.id}
		`;
		expect(Number(merged.merged_into)).toBe(winner.id);
	});

	it("discovers review-only person duplicates without a schema extension", async () => {
		const org = await createTestOrganization({
			name: "Default Person Resolution Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
			UPDATE entities
			SET metadata = ${sql.json({ email: "same@example.com" })}
			WHERE id = ${winner.id}
		`;
		await sql`
			UPDATE entities
			SET metadata = ${sql.json({ email: " SAME@example.com " })}
			WHERE id = ${loser.id}
		`;
		await sql`
			INSERT INTO watchers
			  (id, organization_id, agent_id, created_by, watcher_group_id, name,
			   status, notification_channel, notification_priority,
			   min_cooldown_seconds, created_at, updated_at)
			VALUES
			  (6013, ${org.id}, 'personal-agent', ${user.id}, 6013,
			   'Default person resolution', 'active', 'canvas', 'normal', 0,
			   now(), now())
		`;

		const result = await manageEntity(
			{
				action: "resolve_duplicates",
				candidate_entity_ids: [winner.id, loser.id],
			},
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
				actingWatcherId: 6013,
			} as ToolContext,
		);

		expect(result).toMatchObject({
			action: "resolve_duplicates",
			groups_found: 1,
			auto_merged: 0,
			approvals_queued: 1,
		});
		const [pending] = await sql`
			SELECT approval_status, action_input
			FROM runs
			WHERE organization_id = ${org.id}
			  AND watcher_id = 6013
			  AND run_type = 'internal'
		`;
		expect(pending.approval_status).toBe("pending");
		expect(pending.action_input).toMatchObject({
			operation: "merge",
			winner_entity_id: winner.id,
			entity_ids: [loser.id],
		});
	});

	it("queues one review item per duplicate discovered in the same component", async () => {
		const org = await createTestOrganization({
			name: "Individual Duplicate Review Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const secondLoser = await createTestEntity({
			name: "Second Loser",
			entity_type: "person",
			organization_id: org.id,
			created_by: user.id,
		});
		const sql = getTestDb();
		await sql`
			UPDATE entity_types
			SET metadata_schema = ${sql.json({
				"x-lobu-resolution": {
					rules: [
						{
							fields: ["phone"],
							normalizer: "phone",
							onMatch: "review",
						},
					],
				},
			})}
			WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${winner.id})
		`;
		await sql`
			UPDATE entities
			SET metadata = ${sql.json({ phone: "+44 123 456 789" })}
			WHERE id IN (${winner.id}, ${loser.id}, ${secondLoser.id})
		`;
		await sql`
			UPDATE entities
			SET metadata = metadata || ${sql.json({ title: "Canonical" })}
			WHERE id = ${winner.id}
		`;
		await sql`
			INSERT INTO watchers
			  (id, organization_id, agent_id, created_by, watcher_group_id, name,
			   status, notification_channel, notification_priority,
			   min_cooldown_seconds, created_at, updated_at)
			VALUES
			  (6012, ${org.id}, 'personal-agent', ${user.id}, 6012,
			   'Individual duplicate review', 'active', 'canvas', 'normal', 0,
			   now(), now())
		`;

		const result = await manageEntity(
			{
				action: "resolve_duplicates",
				candidate_entity_ids: [winner.id, loser.id, secondLoser.id],
			},
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
				actingWatcherId: 6012,
			} as ToolContext,
		);
		expect(result).toMatchObject({
			action: "resolve_duplicates",
			groups_found: 1,
			auto_merged: 0,
			approvals_queued: 2,
		});
		const pending = await sql<{ action_input: Record<string, unknown> }[]>`
			SELECT action_input
			FROM runs
			WHERE organization_id = ${org.id}
			  AND watcher_id = 6012
			  AND run_type = 'internal'
			  AND approval_status = 'pending'
			ORDER BY id
		`;
		expect(pending).toHaveLength(2);
		expect(pending.map((row) => row.action_input.entity_ids)).toEqual(
			expect.arrayContaining([[loser.id], [secondLoser.id]]),
		);
	});

	it("suppresses a rejected candidate until its policy or evidence changes", async () => {
		const org = await createTestOrganization({
			name: "Rejected Resolution Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
			INSERT INTO watchers
			  (id, organization_id, agent_id, created_by, watcher_group_id, name,
			   status, notification_channel, notification_priority,
			   min_cooldown_seconds, created_at, updated_at)
			VALUES
			  (6011, ${org.id}, 'personal-agent', ${user.id}, 6011,
			   'Rejected resolution', 'active', 'canvas', 'normal', 0, now(), now())
		`;
		const watcherCtx = {
			...ctx(org.id, user.id, "owner"),
			userId: null,
			agentId: "personal-agent",
			actingWatcherId: 6011,
		} as ToolContext;
		const first = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			watcherCtx,
		)) as unknown as { approval_run_id: number };
		await manageOperations(
			{ action: "reject", run_id: first.approval_run_id },
			env,
			ctx(org.id, user.id, "owner"),
		);

		const unchanged = await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			watcherCtx,
		);
		expect(unchanged).toMatchObject({
			action: "merge",
			approval_suppressed: true,
		});

		await sql`
			UPDATE entities
			SET metadata = jsonb_build_object('phone', '+44 123 456 789')
			WHERE id IN (${winner.id}, ${loser.id})
		`;
		await sql`
			UPDATE entity_types
			SET metadata_schema = ${sql.json({
				type: "object",
				"x-lobu-resolution": {
					rules: [
						{
							fields: ["phone"],
							normalizer: "phone",
							onMatch: "review",
						},
					],
				},
			})}
			WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${winner.id})
		`;
		const changed = await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			watcherCtx,
		);
		expect(changed).toMatchObject({
			action: "merge",
			approval_queued: true,
		});
	});

	it("does not apply an identical pending proposal after another run rejects it", async () => {
		const org = await createTestOrganization({
			name: "Cross Window Rejection Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
			UPDATE entities
			SET metadata = ${sql.json({ email: "same@example.com" })}
			WHERE id IN (${winner.id}, ${loser.id})
		`;
		await sql`
			INSERT INTO watchers
			  (id, organization_id, agent_id, created_by, watcher_group_id, name,
			   status, notification_channel, notification_priority,
			   min_cooldown_seconds, created_at, updated_at)
			VALUES
			  (6014, ${org.id}, 'personal-agent', ${user.id}, 6014,
			   'Cross-window resolution', 'active', 'canvas', 'normal', 0,
			   now(), now())
		`;
		const watcherCtx = (windowId: number) =>
			({
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
				actingWatcherId: 6014,
				actingWindowId: windowId,
			}) as ToolContext;
		const first = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			watcherCtx(7101),
		)) as unknown as { approval_run_id: number };
		const second = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			watcherCtx(7102),
		)) as unknown as { approval_run_id: number };
		expect(second.approval_run_id).not.toBe(first.approval_run_id);

		await manageOperations(
			{ action: "reject", run_id: first.approval_run_id },
			env,
			ctx(org.id, user.id, "owner"),
		);
		const approval = await manageOperations(
			{ action: "approve", run_id: second.approval_run_id },
			env,
			ctx(org.id, user.id, "owner"),
		);
		expect(approval).toMatchObject({
			error: expect.stringContaining("already rejected"),
		});

		const [entity] = await sql`
			SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}
		`;
		expect(entity.merged_into).toBeNull();
		expect(entity.deleted_at).toBeNull();
		const decisions = await sql`
			SELECT id, approval_status, status
			FROM runs
			WHERE id IN (${first.approval_run_id}, ${second.approval_run_id})
			ORDER BY id
		`;
		expect(decisions).toEqual([
			expect.objectContaining({ approval_status: "rejected", status: "cancelled" }),
			expect.objectContaining({ approval_status: "rejected", status: "cancelled" }),
		]);
	});

	it("repairs a legacy pending run that has no approval event", async () => {
		const org = await createTestOrganization({ name: "Orphan Approval Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		const [orphan] = await sql<{ id: number }[]>`
			INSERT INTO runs (
				organization_id, run_type, action_key, action_input,
				approval_status, status
			) VALUES (
				${org.id}, 'internal', 'entity_change',
				${sql.json({
					operation: "merge",
					entity_id: loser.id,
					entity_ids: [loser.id],
					winner_entity_id: winner.id,
					current: { loser: {}, duplicates: [{}], winner: {} },
				})},
				'pending', 'pending'
			)
			RETURNING id
		`;

		const queued = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
			} as ToolContext,
		)) as unknown as { approval_run_id: number };

		expect(queued.approval_run_id).toBe(Number(orphan.id));
		const [repaired] = await sql`
			SELECT idempotency_key,
			       (SELECT count(*)::int FROM current_event_records e
			        WHERE e.run_id = runs.id AND e.interaction_status = 'pending') AS event_count
			FROM runs
			WHERE id = ${orphan.id}
		`;
		expect(repaired.idempotency_key).toMatch(/^entity-change:/);
		expect(Number(repaired.event_count)).toBe(1);
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
			SELECT action_input, idempotency_key FROM runs WHERE id = ${queued.approval_run_id}
		`;
		expect(pending.action_input).toMatchObject({
			operation: "merge",
			entity_ids: [loser.id, secondLoser.id],
			winner_entity_id: winner.id,
		});
		expect(pending.idempotency_key).toMatch(/^entity-change:/);
		const [approvalEvent] = await sql`
      SELECT title, metadata FROM current_event_records
      WHERE run_id = ${queued.approval_run_id} AND interaction_status = 'pending'
    `;
		expect(approvalEvent.title).toBe(
			"Merge 2 person duplicates into Winner — pending approval",
		);
		const current = (approvalEvent.metadata as Record<string, unknown>)
			.current as {
			duplicates: Array<{
				href: string;
				identities: Array<Record<string, unknown>>;
			}>;
		};
		expect(current.duplicates[0]?.href).toContain("/person/");
		expect(current.duplicates[0]).not.toHaveProperty("metadata");
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
		const [run] = await sql`
			SELECT approval_status, status
			FROM runs
			WHERE id = ${queued.approval_run_id}
		`;
		expect(run).toMatchObject({
			approval_status: "pending",
			status: "pending",
		});
		const [approvalEvent] = await sql`
			SELECT interaction_status
			FROM current_event_records
			WHERE run_id = ${queued.approval_run_id}
		`;
		expect(approvalEvent.interaction_status).toBe("pending");
	});

	it("does not apply an approved merge when an identity row appeared after proposal", async () => {
		const org = await createTestOrganization({ name: "Identity Staleness Org" });
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
        (6015, ${org.id}, 'personal-agent', ${user.id}, 6015, 'Identity staleness',
         'active', 'canvas', 'normal', 0, now(), now())
    `;

		const queued = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
				actingWatcherId: 6015,
			} as ToolContext,
		)) as unknown as { approval_run_id: number };

		await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier)
      VALUES (${org.id}, ${loser.id}, 'phone', '447700900123')
    `;
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
		expect(after.deleted_at).toBeNull();
	});

	it("locks identity evidence until the staleness-checked transaction finishes", async () => {
		const org = await createTestOrganization({ name: "Identity Lock Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
			INSERT INTO entity_identities
			  (organization_id, entity_id, namespace, identifier)
			VALUES (${org.id}, ${loser.id}, 'phone', '447700900123')
		`;
		const assessment = assessEntityResolution({
			metadataSchema: { type: "object" },
			entityTypeSlug: "person",
			winner: { id: winner.id, metadata: {} },
			losers: [
				{
					id: loser.id,
					metadata: {},
					identities: [{ namespace: "phone", identifier: "447700900123" }],
				},
			],
		});
		const writer = postgres(process.env.DATABASE_URL as string, {
			max: 1,
			onnotice: () => {},
			...PROD_PG_VALUE_OPTIONS,
		});
		try {
			await sql.begin(async (tx) => {
				await assertResolutionFingerprintCurrent(tx, {
					organizationId: org.id,
					winnerId: winner.id,
					loserIds: [loser.id],
					expectedFingerprint: assessment.fingerprint,
				});
				await expect(
					writer.begin(async (writerTx) => {
						await writerTx`SET LOCAL lock_timeout = '100ms'`;
						await writerTx`
							UPDATE entity_identities
							SET identifier = '447700900124'
							WHERE organization_id = ${org.id}
							  AND entity_id = ${loser.id}
							  AND deleted_at IS NULL
						`;
					}),
				).rejects.toMatchObject({ code: "55P03" });
			});
		} finally {
			await writer.end();
		}
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
