import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { listNotifications } from "../../../notifications/service";
import { listOrgActivity } from "../../../tools/admin/manage_operations/activity-feed";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestConnection,
	createTestEvent,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

async function seedApprovalNotification(opts: {
	organizationId: string;
	userId: string;
	actionKey: string;
	title: string;
	/** When set, the proposal event is tied to this connection. */
	proposalConnectionId?: number;
}): Promise<number> {
	const sql = getTestDb();
	const [run] = await sql`
		INSERT INTO runs (
			organization_id, run_type, action_key, approval_status, status, created_at
		) VALUES (
			${opts.organizationId}, 'internal', ${opts.actionKey},
			'pending', 'pending', now()
		)
		RETURNING id
	`;
	const runId = Number(run.id);
	const proposal = await createTestEvent({
		organization_id: opts.organizationId,
		connection_id: opts.proposalConnectionId,
		title: `${opts.title} proposal`,
		content: "Pending approval",
		semantic_type: "operation",
	});
	await sql`
		UPDATE events
		SET run_id = ${runId},
		    interaction_type = 'approval',
		    interaction_status = 'pending'
		WHERE id = ${proposal.id}
	`;
	const notification = await createTestEvent({
		organization_id: opts.organizationId,
		title: opts.title,
		content: "Review this change",
		semantic_type: "notification",
		metadata: {
			notification_type: "action_approval_needed",
			resource_type: "event",
			resource_id: String(proposal.id),
			resource_url: `/acme/memory?run_ids=${runId}`,
		},
	});
	await sql`
		INSERT INTO notification_targets (event_id, user_id)
		VALUES (${notification.id}, ${opts.userId})
	`;
	return runId;
}

describe("approval notification live state", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	afterAll(async () => {
		await cleanupTestDatabase();
	});

	it("resolves the proposal run and exposes inline policy with current state", async () => {
		const sql = getTestDb();
		const org = await createTestOrganization({ slug: "acme" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const entityRunId = await seedApprovalNotification({
			organizationId: org.id,
			userId: user.id,
			actionKey: "entity_change",
			title: "Merge duplicates",
		});
		await seedApprovalNotification({
			organizationId: org.id,
			userId: user.id,
			actionKey: "manage_behaviors",
			title: "Change Behavior",
		});

		const pending = await listOrgActivity({
			organizationId: org.id,
			userId: user.id,
			ownerSlug: org.slug,
			includeRuns: false,
			aggregate: false,
		});
		expect(pending.items.find((item) => item.title === "Merge duplicates")).toEqual(
			expect.objectContaining({
				run_id: entityRunId,
				interaction_type: "approval",
				interaction_status: "pending",
				interaction_inline: true,
			}),
		);
		expect(pending.items.find((item) => item.title === "Change Behavior")).toEqual(
			expect.objectContaining({
				interaction_type: "approval",
				interaction_status: "pending",
				interaction_inline: undefined,
			}),
		);

		await sql`
			UPDATE runs
			SET approval_status = 'expired', status = 'cancelled'
			WHERE id = ${entityRunId}
		`;
		const expired = await listOrgActivity({
			organizationId: org.id,
			userId: user.id,
			ownerSlug: org.slug,
			includeRuns: false,
			aggregate: false,
		});
		expect(expired.items.find((item) => item.title === "Merge duplicates")).toEqual(
			expect.objectContaining({
				run_id: entityRunId,
				interaction_type: "approval",
				interaction_status: "expired",
				interaction_inline: true,
			}),
		);
	});

	it("resolves a pending approval whose review card is unreachable as expired", async () => {
		const sql = getTestDb();
		const org = await createTestOrganization({ slug: "acme" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const conn = await createTestConnection({
			organization_id: org.id,
			connector_key: "apple.computer_use",
			created_by: user.id,
		});
		// Soft-delete the connection: its events vanish from every content read
		// (connection-visibility predicate), so the approval card is unreachable
		// even though the raw-row notification join still resolves the pending
		// run. The card must resolve terminal, never as an actionable pending.
		await sql`UPDATE connections SET deleted_at = NOW() WHERE id = ${conn.id}`;
		await seedApprovalNotification({
			organizationId: org.id,
			userId: user.id,
			actionKey: "observe",
			title: "Observe UI",
			proposalConnectionId: conn.id,
		});

		const { notifications } = await listNotifications({
			organizationId: org.id,
			userId: user.id,
			limit: 50,
		});
		const notif = notifications.find((n) => n.title === "Observe UI");
		expect(notif).toBeDefined();
		expect(notif?.interaction_type).toBe("approval");
		expect(notif?.approval_status).toBe("expired");

		const feed = await listOrgActivity({
			organizationId: org.id,
			userId: user.id,
			ownerSlug: org.slug,
			includeRuns: false,
			aggregate: false,
		});
		expect(feed.items.find((item) => item.title === "Observe UI")).toEqual(
			expect.objectContaining({
				interaction_type: "approval",
				interaction_status: "expired",
			}),
		);
	});
});
