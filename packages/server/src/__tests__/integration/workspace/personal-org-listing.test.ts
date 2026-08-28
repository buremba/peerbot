import { beforeEach, describe, expect, it } from "vitest";
import {
	getWorkspaceProvider,
	initWorkspaceProvider,
} from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

describe("workspace personal marker listing", () => {
	beforeEach(async () => {
		await initWorkspaceProvider();
		await cleanupTestDatabase();
	});

	it("marks only the authenticated user personal workspace and never marks anonymous public rows", async () => {
		const sql = getTestDb();
		const personal = await createTestOrganization({ name: "Listing Personal" });
		const team = await createTestOrganization({ name: "Listing Team" });
		const publicOrg = await createTestOrganization({
			name: "Listing Public",
			visibility: "public",
		});
		const user = await createTestUser({ name: "Listing User" });
		await addUserToOrganization(user.id, personal.id, "owner");
		await addUserToOrganization(user.id, team.id, "member");
		await sql`
      UPDATE organization
      SET metadata = ${JSON.stringify({ personal_org_for_user_id: user.id })}
      WHERE id = ${personal.id}
    `;

		const provider = getWorkspaceProvider();
		const authenticated = await provider.listOrganizations(undefined, user.id);
		expect(
			authenticated.find((organization) => organization.id === personal.id)
				?.is_personal,
		).toBe(true);
		expect(
			authenticated.find((organization) => organization.id === team.id)
				?.is_personal,
		).toBe(false);
		expect(
			authenticated.find((organization) => organization.id === publicOrg.id)
				?.is_personal,
		).toBe(false);

		const anonymous = await provider.listOrganizations();
		expect(
			anonymous.every((organization) => organization.is_personal === false),
		).toBe(true);
	});
});
