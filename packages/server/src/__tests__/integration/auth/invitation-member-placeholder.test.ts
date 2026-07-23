import { beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestSession,
	createTestUser,
} from "../../setup/test-fixtures";
import { post } from "../../setup/test-helpers";
import { provisionMemberAndCoreIdentities } from "../../../auth/subject-identities";
import { ensureMemberEntity } from "../../../utils/member-entity";

vi.mock("../../../email/send", () => ({
	sendTransactionalEmail: vi.fn().mockResolvedValue({ id: null }),
}));

describe("invitation member placeholder", () => {
	let orgId: string;
	let inviterUserId: string;
	let inviterCookie: string;
	const inviteeEmail = "pending-invitee@test.example.com";

	beforeAll(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({
			name: "Invite Claim Org",
			slug: "invite-claim-org",
			visibility: "private",
		});
		orgId = org.id;
		const inviter = await createTestUser({ email: "inviter@test.example.com" });
		inviterUserId = inviter.id;
		await addUserToOrganization(inviter.id, orgId, "owner");
		inviterCookie = (await createTestSession(inviter.id)).cookieHeader;
	});

	it("does not assign the inviter identity to the invitee placeholder", async () => {
		const response = await post("/api/auth/organization/invite-member", {
			body: {
				organizationId: orgId,
				email: inviteeEmail,
				role: "member",
			},
			cookie: inviterCookie,
		});
		expect(response.status).toBe(200);

		const sql = getTestDb();

		const inviteeRows = await sql<{ id: number; created_by: string | null }>`
      SELECT e.id, e.created_by
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id AND et.organization_id = e.organization_id
      WHERE et.slug = '$member'
        AND e.organization_id = ${orgId}
        AND e.metadata->>'email' = ${inviteeEmail}
        AND e.deleted_at IS NULL
    `;
		expect(inviteeRows).toHaveLength(1);
		const inviteeEntityId = Number(inviteeRows[0].id);
		expect(inviteeRows[0].created_by).toBe(inviterUserId);

		const claims = await sql<{ identifier: string }>`
      SELECT identifier
      FROM entity_identities
      WHERE organization_id = ${orgId}
        AND entity_id = ${inviteeEntityId}
        AND namespace = 'auth_user_id'
        AND deleted_at IS NULL
    `;
		expect(claims).toHaveLength(0);
	});

	it("refuses claims when userId does not own the member email", async () => {
		const sql = getTestDb();
		const victimEmail = "victim-invariant@test.example.com";

		await ensureMemberEntity({
			organizationId: orgId,
			userId: inviterUserId,
			name: victimEmail,
			email: victimEmail,
			role: "member",
			status: "active",
		});
		await expect(
			provisionMemberAndCoreIdentities(orgId, {
				userId: inviterUserId,
				email: victimEmail,
				name: victimEmail,
			}),
		).rejects.toThrow("does not own");

		const victimRows = await sql<{ id: number }>`
      SELECT e.id
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id AND et.organization_id = e.organization_id
      WHERE et.slug = '$member'
        AND e.organization_id = ${orgId}
        AND e.metadata->>'email' = ${victimEmail}
        AND e.deleted_at IS NULL
    `;
		expect(victimRows).toHaveLength(1);

		const leaked = await sql<{ identifier: string }>`
      SELECT identifier
      FROM entity_identities
      WHERE organization_id = ${orgId}
        AND entity_id = ${Number(victimRows[0].id)}
        AND namespace = 'auth_user_id'
        AND deleted_at IS NULL
    `;
		expect(leaked).toHaveLength(0);
	});

	it("provisions a fresh $member with the caller's role, not a hardcoded owner", async () => {
		const sql = getTestDb();
		const memberUser = await createTestUser({
			email: "regular-member@test.example.com",
		});
		await addUserToOrganization(memberUser.id, orgId, "member");

		// The backfill path passes the member row's actual role. A drifted
		// non-owner must NOT be minted as an owner.
		await provisionMemberAndCoreIdentities(orgId, {
			userId: memberUser.id,
			email: memberUser.email,
			name: "Regular Member",
			role: "member",
		});

		const rows = await sql<{ role: string | null }>`
      SELECT e.metadata->>'role' AS role
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id AND et.organization_id = e.organization_id
      WHERE et.slug = '$member'
        AND e.organization_id = ${orgId}
        AND e.metadata->>'email' = ${memberUser.email}
        AND e.deleted_at IS NULL
    `;
		expect(rows).toHaveLength(1);
		expect(rows[0].role).toBe("member");
	});
});
