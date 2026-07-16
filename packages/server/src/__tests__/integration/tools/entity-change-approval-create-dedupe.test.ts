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
});
