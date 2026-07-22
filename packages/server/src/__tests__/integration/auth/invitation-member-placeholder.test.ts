import { beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestSession,
	createTestUser,
} from "../../setup/test-fixtures";
import { post } from "../../setup/test-helpers";

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
});
