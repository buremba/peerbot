/**
 * Regression: active create approvals must only collapse true replays.
 *
 * Create proposals have no entity_id, so the approval dedupe query must compare
 * the proposed entity payload. Otherwise every distinct pending create in an org
 * reuses the first pending create run.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
	type EntityCreateProposal,
	proposeEntityCreate,
} from "../../../tools/admin/entity-field-approval";
import type { ToolContext } from "../../../tools/registry";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestOrganization } from "../../setup/test-fixtures";

function createProposal(name: string): Omit<EntityCreateProposal, "operation"> {
	return {
		entity_data: {
			entity_type: "task",
			name,
			metadata: { title: name },
		},
		proposal: {
			entity_type: "task",
			name,
			metadata: { title: name },
		},
		attribution: "agent",
		reason: `Create ${name}`,
	};
}

describe("entity create approval dedupe", () => {
	let ctx: ToolContext;

	beforeAll(async () => {
		await initWorkspaceProvider();
		await cleanupTestDatabase();
		const org = await createTestOrganization({
			name: "Entity Create Approval Dedupe Org",
		});
		ctx = {
			organizationId: org.id,
			agentId: "agent-create-approval-test",
			memberRole: "member",
			isAuthenticated: true,
			tokenType: "oauth",
			scopedToOrg: true,
		} as ToolContext;
	});

	it("separates distinct creates and reuses pending or in-flight replays", async () => {
		const first = await proposeEntityCreate(ctx, createProposal("Call Alice"));
		const replay = await proposeEntityCreate(ctx, createProposal("Call Alice"));
		const sql = getTestDb();
		await sql`
			UPDATE runs
			SET approval_status = 'approved', status = 'running'
			WHERE id = ${first.runId}
		`;
		const inFlightReplay = await proposeEntityCreate(
			ctx,
			createProposal("Call Alice"),
		);
		const second = await proposeEntityCreate(ctx, createProposal("Call Bob"));

		expect(replay.runId).toBe(first.runId);
		expect(inFlightReplay.runId).toBe(first.runId);
		expect(second.runId).not.toBe(first.runId);
	});

	it("serializes concurrent replicas to one run and approval event", async () => {
		const name = "Call Concurrent";
		const proposals = await Promise.all(
			Array.from({ length: 8 }, () =>
				proposeEntityCreate(ctx, createProposal(name)),
			),
		);
		const runIds = new Set(proposals.map((proposal) => proposal.runId));
		expect(runIds.size).toBe(1);

		const runId = proposals[0]?.runId;
		expect(runId).toBeDefined();
		const sql = getTestDb();
		const activeRuns = await sql`
			SELECT id
			FROM runs
			WHERE organization_id = ${ctx.organizationId}
			  AND action_input->'entity_data'->>'name' = ${name}
			  AND status IN ('pending', 'claimed', 'running')
		`;
		expect(activeRuns).toHaveLength(1);

		const currentEvents = await sql`
			SELECT id
			FROM current_event_records
			WHERE run_id = ${runId}
			  AND interaction_type = 'approval'
		`;
		expect(currentEvents).toHaveLength(1);
	});
});
