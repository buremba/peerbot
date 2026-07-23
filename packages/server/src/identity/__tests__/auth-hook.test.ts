import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTestDatabase, getTestDb } from "../../__tests__/setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
} from "../../__tests__/setup/test-fixtures";
import { provisionMemberAndCoreIdentities } from "../../auth/subject-identities";
import { resolveTenantMember } from "../auth-hook";

describe("resolveTenantMember", () => {
	beforeEach(cleanupTestDatabase);
	afterEach(cleanupTestDatabase);

	it("prefers the tagged personal org over an older private shared org", async () => {
		const sharedOrg = await createTestOrganization({ name: "Shared" });
		const personalOrg = await createTestOrganization({ name: "Personal" });
		const user = await createTestUser({
			name: "Alice",
			email: "alice@acme.test",
		});
		await addUserToOrganization(user.id, sharedOrg.id, "member");
		await addUserToOrganization(user.id, personalOrg.id, "owner");
		await provisionMemberAndCoreIdentities(sharedOrg.id, {
			userId: user.id,
			email: user.email,
			name: user.name,
		});
		const personal = await provisionMemberAndCoreIdentities(personalOrg.id, {
			userId: user.id,
			email: user.email,
			name: user.name,
		});

		const sql = getTestDb();
		await sql`
      UPDATE organization
      SET "createdAt" = '2020-01-01T00:00:00Z'
      WHERE id = ${sharedOrg.id}
    `;
		await sql`
      UPDATE organization
      SET "createdAt" = '2021-01-01T00:00:00Z',
          metadata = ${JSON.stringify({ personal_org_for_user_id: user.id })}
      WHERE id = ${personalOrg.id}
    `;

		await expect(resolveTenantMember(user.id)).resolves.toEqual({
			tenantOrganizationId: personalOrg.id,
			memberEntityId: personal.memberEntityId,
		});
	});
});
