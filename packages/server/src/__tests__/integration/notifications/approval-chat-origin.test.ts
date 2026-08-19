/**
 * Tier 1 of approval delivery: the conversation that asked.
 *
 * The sharp case is the hosted-preview binding — a channel this org reaches
 * through a connection that lives in a DIFFERENT org. Any reachability check
 * scoped to the notifying org's own `connections` finds no row and reports the
 * channel unreachable, so every preview-served org silently loses tier 1 and
 * answers a channel question in the asker's DM instead. Found in prod: the org
 * whose only binding is preview-served resolved to no chat origin at all.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resolveApprovalChatOrigin } from "../../../tools/admin/approval-delivery";
import type { ToolContext } from "../../../tools/registry";
import { cleanupTestDatabase } from "../../setup/test-db";
import { createTestAutomationSubscription } from "../../setup/automation-subscriptions";
import {
	addUserToOrganization,
	createTestAgent,
	createTestOrganization,
	createTestUser,
	insertChatConnectionRow,
} from "../../setup/test-fixtures";

const TEAM = "T_ORIGIN";

function ctxFor(opts: {
	organizationId: string;
	agentId: string | null;
	connectionId?: string;
	channelId?: string;
}): ToolContext {
	return {
		organizationId: opts.organizationId,
		userId: "user-asker",
		agentId: opts.agentId,
		memberRole: null,
		isAuthenticated: true,
		tokenType: "oauth",
		scopedToOrg: true,
		sourceContext:
			opts.connectionId && opts.channelId
				? {
						platform: "slack",
						connectionId: opts.connectionId,
						channelId: opts.channelId,
						conversationId: opts.channelId,
						teamId: TEAM,
						userId: "U_ASKER",
					}
				: null,
	} as unknown as ToolContext;
}

async function seedBinding(opts: {
	organizationId: string;
	agentId: string;
	connectionId: string;
	channelId: string;
}): Promise<void> {
	const configuredBy = await createTestUser();
	await addUserToOrganization(configuredBy.id, opts.organizationId, "owner");
	await createTestAutomationSubscription({
		organizationId: opts.organizationId,
		agentId: opts.agentId,
		connectionSlug: `agentconn-${opts.connectionId}`,
		platform: "slack",
		channelId: opts.channelId,
		teamId: TEAM,
		configuredBy: configuredBy.id,
	});
}

describe("resolveApprovalChatOrigin", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});
	afterAll(async () => {
		await cleanupTestDatabase();
	});

	it("resolves the originating channel for an own-connection binding", async () => {
		const org = await createTestOrganization();
		const agent = await createTestAgent({
			organizationId: org.id,
			agentId: "crm",
		});
		await insertChatConnectionRow({
			id: "conn-own",
			organizationId: org.id,
			agentId: agent.agentId,
			platform: "slack",
			status: "active",
			settings: {},
			metadata: {},
		});
		await seedBinding({
			organizationId: org.id,
			agentId: agent.agentId,
			connectionId: "conn-own",
			channelId: "slack:C0ASKED",
		});

		const target = await resolveApprovalChatOrigin(
			ctxFor({
				organizationId: org.id,
				agentId: agent.agentId,
				connectionId: "conn-own",
				channelId: "slack:C0ASKED",
			}),
		);

		expect(target).toEqual({
			connectionId: "conn-own",
			channelId: "slack:C0ASKED",
			teamId: TEAM,
		});
	});

	// The regression this file exists for.
	it("resolves the originating channel for a hosted-preview cross-org binding", async () => {
		const hostOrg = await createTestOrganization();
		const tenantOrg = await createTestOrganization();
		const tenantAgent = await createTestAgent({
			organizationId: tenantOrg.id,
			agentId: "product-ops",
		});
		// The connection lives in the HOST org; the binding belongs to the tenant.
		await insertChatConnectionRow({
			id: "preview-conn",
			organizationId: hostOrg.id,
			agentId: "concierge",
			platform: "slack",
			status: "active",
			settings: { previewMode: true },
			metadata: {},
		});
		await seedBinding({
			organizationId: tenantOrg.id,
			agentId: tenantAgent.agentId,
			connectionId: "preview-conn",
			channelId: "slack:C0PREVIEW",
		});

		const target = await resolveApprovalChatOrigin(
			ctxFor({
				organizationId: tenantOrg.id,
				agentId: tenantAgent.agentId,
				connectionId: "preview-conn",
				channelId: "slack:C0PREVIEW",
			}),
		);

		expect(target).toEqual({
			connectionId: "preview-conn",
			channelId: "slack:C0PREVIEW",
			teamId: TEAM,
		});
	});

	it("returns no target for a channel the agent is not bound to", async () => {
		const org = await createTestOrganization();
		const agent = await createTestAgent({
			organizationId: org.id,
			agentId: "crm",
		});
		await insertChatConnectionRow({
			id: "conn-own",
			organizationId: org.id,
			agentId: agent.agentId,
			platform: "slack",
			status: "active",
			settings: {},
			metadata: {},
		});
		await seedBinding({
			organizationId: org.id,
			agentId: agent.agentId,
			connectionId: "conn-own",
			channelId: "slack:C0ASKED",
		});

		const target = await resolveApprovalChatOrigin(
			ctxFor({
				organizationId: org.id,
				agentId: agent.agentId,
				connectionId: "conn-own",
				channelId: "slack:C0SOMEWHERE_ELSE",
			}),
		);

		expect(target).toEqual({
			connectionId: null,
			channelId: null,
			teamId: null,
		});
	});

	it("returns no target for an agentless turn", async () => {
		const org = await createTestOrganization();

		const target = await resolveApprovalChatOrigin(
			ctxFor({
				organizationId: org.id,
				agentId: null,
				connectionId: "conn-own",
				channelId: "slack:C0ASKED",
			}),
		);

		expect(target.channelId).toBeNull();
	});

	it("returns no target when the turn carries no chat source", async () => {
		const org = await createTestOrganization();
		const agent = await createTestAgent({
			organizationId: org.id,
			agentId: "crm",
		});

		const target = await resolveApprovalChatOrigin(
			ctxFor({ organizationId: org.id, agentId: agent.agentId }),
		);

		expect(target.channelId).toBeNull();
	});
});
