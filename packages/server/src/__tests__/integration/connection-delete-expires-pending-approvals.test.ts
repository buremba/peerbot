/**
 * Connection delete — pending-approval reconcile.
 *
 * Deleting a connection makes its pending approvals unreviewable: the approval
 * card disappears from every content read (connection-visibility predicate), so
 * approve/reject would be blind. The delete must transition those runs terminal
 * (expired/cancelled) instead of leaving them dangling behind a "needs
 * approval" notification with nothing to review.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnection,
	createTestOrganization,
	createTestUser,
} from "../setup/test-fixtures";
import { TestApiClient } from "../setup/test-mcp-client";

async function seedPendingApprovalRun(opts: {
	organizationId: string;
	connectionId: number;
	connectorKey: string;
	actionKey: string;
}): Promise<number> {
	const sql = getTestDb();
	const [run] = await sql`
		INSERT INTO runs (
			organization_id, run_type, connection_id, connector_key,
			action_key, approval_status, status, created_at
		) VALUES (
			${opts.organizationId}, 'action', ${opts.connectionId}, ${opts.connectorKey},
			${opts.actionKey}, 'pending', 'pending', NOW()
		)
		RETURNING id
	`;
	return Number(run.id);
}

describe("connection delete expires pending approvals", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("transitions a pending approval run on the deleted connection to expired/cancelled", async () => {
		const sql = getTestDb();
		const org = await createTestOrganization({ name: "Acme" });
		const user = await createTestUser();
		const conn = await createTestConnection({
			organization_id: org.id,
			connector_key: "apple.computer_use",
			created_by: user.id,
		});
		const runId = await seedPendingApprovalRun({
			organizationId: org.id,
			connectionId: conn.id,
			connectorKey: "apple.computer_use",
			actionKey: "observe",
		});

		const client = await TestApiClient.for({
			organizationId: org.id,
			userId: user.id,
			memberRole: "owner",
		});
		const result = (await client.connections.delete(conn.id)) as {
			deleted?: boolean;
		};
		expect(result.deleted).toBe(true);

		const [row] = await sql`
			SELECT approval_status, status, completed_at
			FROM runs
			WHERE id = ${runId}
		`;
		expect(row?.approval_status).toBe("expired");
		expect(row?.status).toBe("cancelled");
		expect(row?.completed_at).not.toBeNull();
	});

	it("leaves pending approvals on other connections untouched", async () => {
		const sql = getTestDb();
		const org = await createTestOrganization({ name: "Acme 2" });
		const user = await createTestUser();
		const deletedConn = await createTestConnection({
			organization_id: org.id,
			connector_key: "apple.computer_use",
			created_by: user.id,
		});
		const keptConn = await createTestConnection({
			organization_id: org.id,
			connector_key: "x",
			created_by: user.id,
		});
		const keptRunId = await seedPendingApprovalRun({
			organizationId: org.id,
			connectionId: keptConn.id,
			connectorKey: "x",
			actionKey: "prepare_reply",
		});

		const client = await TestApiClient.for({
			organizationId: org.id,
			userId: user.id,
			memberRole: "owner",
		});
		await client.connections.delete(deletedConn.id);

		const [row] = await sql`
			SELECT approval_status, status
			FROM runs
			WHERE id = ${keptRunId}
		`;
		expect(row?.approval_status).toBe("pending");
		expect(row?.status).toBe("pending");
	});
});
