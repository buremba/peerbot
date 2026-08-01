/**
 * Owner-routed approvals — the resolution halves:
 *
 *  1. Propose-time owner resolution: proposeEntityFieldChange records
 *     action_input.owner_user_id ONLY when the gated fields have exactly one
 *     distinct field_controls.set_by. Mixed owners or $-attribute-only
 *     proposals record nothing (admin-only behavior).
 *  2. Delivery-tier selection: resolveOwnerDmTarget picks the owner's Slack
 *     identity in a workspace one of the org's bot connections is bound to;
 *     no identity → null (caller falls back to channel delivery).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import { resolveSlackUserIdForUser } from "../../../lobu/stores/chat-identity";
import { resolveOwnerDmTarget } from "../../../notifications/service";
import { proposeEntityFieldChange } from "../../../tools/admin/entity-field-approval";
import type { ToolContext } from "../../../tools/registry";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestBehaviorSubscription } from "../../setup/behavior-subscriptions";
import {
	addUserToOrganization,
	createTestAgent,
	createTestEntity,
	createTestOrganization,
	createTestUser,
	insertChatConnectionRow,
	linkSlackIdentityInGraph,
} from "../../setup/test-fixtures";

const TEAM_ID = "T-OWNERROUTE";

function agentCtx(organizationId: string): ToolContext {
	return {
		organizationId,
		userId: null,
		agentId: "agent-owner-routing",
		memberRole: null,
		isAuthenticated: true,
		tokenType: "oauth",
		scopedToOrg: true,
	} as unknown as ToolContext;
}

async function seedOwnedEntity(
	orgId: string,
	createdBy: string,
	name: string,
	controls: Record<string, { set_by: string }>,
): Promise<number> {
	const sql = getTestDb();
	const entity = await createTestEntity({
		name,
		organization_id: orgId,
		created_by: createdBy,
	});
	await sql`
    UPDATE entities SET
      metadata = ${sql.json({ severity: "high", status: "open" })},
      field_controls = ${sql.json(controls)}
    WHERE id = ${entity.id}
  `;
	return entity.id;
}

async function proposedOwner(runId: number): Promise<string | null> {
	const rows = await getDb()<{ owner: string | null }>`
    SELECT action_input->>'owner_user_id' AS owner FROM runs WHERE id = ${runId}
  `;
	return rows[0]?.owner ?? null;
}

describe("owner-routed approvals — resolution", () => {
	let orgId: string;
	let alice: { id: string };
	let bob: { id: string };

	beforeAll(async () => {
		await initWorkspaceProvider();
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "Owner Routing Org" });
		orgId = org.id;
		alice = await createTestUser({ name: "Alice" });
		bob = await createTestUser({ name: "Bob" });
		await addUserToOrganization(alice.id, orgId, "member");
		await addUserToOrganization(bob.id, orgId, "member");
	});

	it("records the owner when ONE user owns all gated fields (unowned fields don't break it)", async () => {
		const entityId = await seedOwnedEntity(orgId, alice.id, "Single Owner", {
			severity: { set_by: alice.id },
		});
		// `status` is gated but unowned; `severity` is Alice's → exactly one owner.
		const res = await proposeEntityFieldChange(agentCtx(orgId), {
			entity_id: entityId,
			fields: { severity: "critical", status: "closed" },
			current: { severity: "high", status: "open" },
			attribution: "agent",
		});
		expect(await proposedOwner(res.runId)).toBe(alice.id);
	});

	it("records NO owner when two users own different gated fields", async () => {
		const entityId = await seedOwnedEntity(orgId, alice.id, "Mixed Owners", {
			severity: { set_by: alice.id },
			status: { set_by: bob.id },
		});
		const res = await proposeEntityFieldChange(agentCtx(orgId), {
			entity_id: entityId,
			fields: { severity: "critical", status: "closed" },
			current: { severity: "high", status: "open" },
			attribution: "agent",
		});
		expect(await proposedOwner(res.runId)).toBeNull();
	});

	it("records NO owner when only reserved $-attributes are gated", async () => {
		const entityId = await seedOwnedEntity(orgId, alice.id, "Attr Only", {
			severity: { set_by: alice.id },
		});
		const res = await proposeEntityFieldChange(agentCtx(orgId), {
			entity_id: entityId,
			fields: { $name: "Renamed" },
			current: { $name: "Attr Only" },
			attribution: "agent",
		});
		expect(await proposedOwner(res.runId)).toBeNull();
	});
});

describe("owner-routed approvals — DM delivery tier selection", () => {
	let orgId: string;
	let owner: { id: string };
	let connectionId: string;

	beforeAll(async () => {
		const sql = getTestDb();
		const org = await createTestOrganization({ name: "Owner DM Org" });
		orgId = org.id;
		owner = await createTestUser({ name: "DM Owner" });
		await addUserToOrganization(owner.id, orgId, "member");

		const agent = await createTestAgent({
			organizationId: orgId,
			ownerUserId: owner.id,
			agentId: "agent-dm-tier",
			name: "DM Tier Agent",
		});
		connectionId = "conn-dm-tier";
		await insertChatConnectionRow({
			id: connectionId,
			organizationId: orgId,
			platform: "slack",
			metadata: { teamId: TEAM_ID },
		});
		await createTestBehaviorSubscription({
			organizationId: orgId,
			agentId: agent.agentId,
			connectionSlug: `agentconn-${connectionId}`,
			platform: "slack",
			channelId: "slack:C-BOUND",
			teamId: TEAM_ID,
		});
	});

	it("picks the owner's Slack identity in the connected workspace", async () => {
		await linkSlackIdentityInGraph({
			organizationId: orgId,
			userId: owner.id,
			teamId: TEAM_ID,
			slackUserId: "U-DMOWNER",
		});
		const target = await resolveOwnerDmTarget(orgId, owner.id);
		expect(target).toEqual({ connectionId, slackUserId: "U-DMOWNER" });
	});

	it("returns null when the owner has no Slack identity (caller falls back)", async () => {
		const stranger = await createTestUser({ name: "No Identity" });
		await addUserToOrganization(stranger.id, orgId, "member");
		expect(await resolveOwnerDmTarget(orgId, stranger.id)).toBeNull();
	});

	it("FAILS CLOSED when one user holds two Slack ids under the same team", async () => {
		// The stamps are org-scoped rows and are never deleted when superseded, so
		// a user in two orgs — or whose Slack account id changed inside one
		// workspace — can hold two DISTINCT ids under the same `TEAM:` prefix.
		// The caller uses this as a DM RECIPIENT, so picking arbitrarily would
		// send the owner DM to a stale Slack account and lose it silently.
		const twin = await createTestUser({ name: "Two Workspaces One Team" });
		await addUserToOrganization(twin.id, orgId, "member");
		const otherOrg = await createTestOrganization({ name: "Second Org" });
		await addUserToOrganization(twin.id, otherOrg.id, "member");
		await linkSlackIdentityInGraph({
			organizationId: orgId,
			userId: twin.id,
			teamId: "TDUPTEAM",
			slackUserId: "U-FIRST",
		});
		await linkSlackIdentityInGraph({
			organizationId: otherOrg.id,
			userId: twin.id,
			teamId: "TDUPTEAM",
			slackUserId: "U-SECOND",
		});

		expect(await resolveSlackUserIdForUser(twin.id, "TDUPTEAM")).toBeNull();
	});

	it("matches the team prefix literally — `_` in a team id is not a LIKE wildcard", async () => {
		// `_` is legal in a team id AND a single-char LIKE wildcard, so an
		// unescaped prefix `T_DMOWNER:%` would also match `TXDMOWNER:…` and hand
		// back a user id from the wrong workspace.
		const roamer = await createTestUser({ name: "Wildcard Roamer" });
		await addUserToOrganization(roamer.id, orgId, "member");
		await linkSlackIdentityInGraph({
			organizationId: orgId,
			userId: roamer.id,
			teamId: "TXDMOWNER",
			slackUserId: "U-ROAMER",
		});
		expect(await resolveSlackUserIdForUser(roamer.id, "TXDMOWNER")).toBe(
			"U-ROAMER",
		);
		expect(await resolveSlackUserIdForUser(roamer.id, "T_DMOWNER")).toBeNull();
	});
});
