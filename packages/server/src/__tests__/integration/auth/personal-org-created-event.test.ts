/**
 * `events` is the workspace's history, and the first thing that ever happened
 * to a workspace is being created — so provisioning records a config-audit row
 * for it. `ensurePersonalOrganization` is also the login path for every
 * existing personal org, so the row must be written exactly once, on create.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { generateSecureToken } from "../../../auth/oauth/utils";
import { ensurePersonalOrganization } from "../../../auth/personal-org-provisioning";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";

async function seedUser(name: string): Promise<{ id: string; email: string }> {
	const id = `user_${generateSecureToken(6)}`;
	const email = `${id}@test.local`;
	const sql = getTestDb();
	await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${id}, ${name}, ${email}, true, NOW(), NOW())
  `;
	return { id, email };
}

async function readCreationEvents(organizationId: string) {
	const sql = getTestDb();
	return await sql`
    SELECT title, origin_type, created_by, metadata, payload_data
    FROM events
    WHERE organization_id = ${organizationId}
      AND metadata->>'resource_kind' = 'organization'
    ORDER BY id
  `;
}

/** The write is fire-and-forget, so give the retry wrapper a beat to land. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 250));
}

describe("ensurePersonalOrganization workspace-created event", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("records one config-audit row naming the new workspace", async () => {
		const { id, email } = await seedUser("Event Me");
		const result = await ensurePersonalOrganization({ id, email, name: "Event Me" });
		expect(result.created).toBe(true);
		await settle();

		const rows = await readCreationEvents(result.organizationId);
		expect(rows).toHaveLength(1);
		expect(rows[0].title).toBe(`Workspace '${result.slug}' created`);
		expect(rows[0].origin_type).toBe("config_organization_created");
		expect(rows[0].created_by).toBe(id);
		expect(rows[0].metadata.category).toBe("config");
		expect(rows[0].metadata.op).toBe("created");
		expect(rows[0].payload_data.state.slug).toBe(result.slug);
	});

	it("does not append a second row when an existing user signs in again", async () => {
		const { id, email } = await seedUser("Returning User");
		const first = await ensurePersonalOrganization({ id, email, name: "Returning User" });
		await settle();

		// Same call, same user: this is the login path, not a new workspace.
		const second = await ensurePersonalOrganization({ id, email, name: "Returning User" });
		expect(second.created).toBe(false);
		expect(second.organizationId).toBe(first.organizationId);
		await settle();

		const rows = await readCreationEvents(first.organizationId);
		expect(rows).toHaveLength(1);
	});
});
