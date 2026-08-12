/**
 * Connection delete — pending-approval reconcile.
 *
 * Deleting a connection makes its pending approvals unreviewable: the approval
 * card disappears from every content read (connection-visibility predicate), so
 * approve/reject would be blind. The delete must transition those runs terminal
 * (expired/cancelled) instead of leaving them dangling behind a "needs
 * approval" notification with nothing to review.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ChatInstanceManager } from "../../gateway/connections/chat-instance-manager";
import { SecretStoreRegistry } from "../../gateway/secrets/index";
import { __setChatInstanceManagerForTests } from "../../lobu/gateway";
import { createPostgresAppInstallationStore } from "../../lobu/stores/app-installation-store";
import { PostgresSecretStore } from "../../lobu/stores/postgres-secret-store";
import { createPostgresAgentConnectionStore } from "../../lobu/stores/postgres-stores";
import { upsertSlackInstallByTeam } from "../../lobu/stores/slack-installations";
import { insertEvent } from "../../utils/insert-event";
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
	const runId = Number(run.id);
	await insertEvent({
		entityIds: [],
		organizationId: opts.organizationId,
		originId: `run_${runId}_pending`,
		title: `${opts.actionKey} — pending approval`,
		content: "Awaiting review",
		semanticType: "operation",
		connectorKey: opts.connectorKey,
		connectionId: opts.connectionId,
		runId,
		interactionType: "approval",
		interactionStatus: "pending",
		metadata: { action_key: opts.actionKey, run_id: runId },
	});
	return runId;
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
		const [card] = await sql`
			SELECT interaction_status, metadata
			FROM current_event_records
			WHERE organization_id = ${org.id}
			  AND run_id = ${runId}
			  AND interaction_type = 'approval'
		`;
		expect(card?.interaction_status).toBe("rejected");
		expect(card?.metadata?.approval_status).toBe("expired");
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

	it("rolls back the deletion and every expiry when one approval card cannot advance", async () => {
		const sql = getTestDb();
		const org = await createTestOrganization({ name: "Acme atomic delete" });
		const user = await createTestUser();
		const conn = await createTestConnection({
			organization_id: org.id,
			connector_key: "apple.computer_use",
			created_by: user.id,
		});
		const firstRunId = await seedPendingApprovalRun({
			organizationId: org.id,
			connectionId: conn.id,
			connectorKey: "apple.computer_use",
			actionKey: "observe",
		});
		const failingRunId = await seedPendingApprovalRun({
			organizationId: org.id,
			connectionId: conn.id,
			connectorKey: "apple.computer_use",
			actionKey: "click",
		});

		await sql.unsafe(`
			CREATE OR REPLACE FUNCTION test_fail_connection_delete_supersede()
				RETURNS trigger AS $fn$
			BEGIN
				IF NEW.supersedes_event_id IS NOT NULL AND NEW.run_id = ${failingRunId} THEN
					RAISE EXCEPTION 'simulated connection-delete supersede failure';
				END IF;
				RETURN NEW;
			END;
			$fn$ LANGUAGE plpgsql;
			CREATE TRIGGER test_fail_connection_delete_supersede_trg
				BEFORE INSERT ON events
				FOR EACH ROW EXECUTE FUNCTION test_fail_connection_delete_supersede();
		`);

		try {
			const client = await TestApiClient.for({
				organizationId: org.id,
				userId: user.id,
				memberRole: "owner",
			});
			await expect(client.connections.delete(conn.id)).rejects.toThrow(
				/supersede failure/i,
			);

			const [connection] = await sql`
				SELECT deleted_at FROM connections WHERE id = ${conn.id}
			`;
			expect(connection?.deleted_at).toBeNull();

			const runs = await sql`
				SELECT id, approval_status, status
				FROM runs
				WHERE id IN (${firstRunId}, ${failingRunId})
				ORDER BY id
			`;
			expect(runs).toEqual([
				expect.objectContaining({
					id: firstRunId,
					approval_status: "pending",
					status: "pending",
				}),
				expect.objectContaining({
					id: failingRunId,
					approval_status: "pending",
					status: "pending",
				}),
			]);

			const cards = await sql`
				SELECT run_id, interaction_status
				FROM current_event_records
				WHERE run_id IN (${firstRunId}, ${failingRunId})
				  AND interaction_type = 'approval'
				ORDER BY run_id
			`;
			expect(cards).toEqual([
				expect.objectContaining({
					run_id: firstRunId,
					interaction_status: "pending",
				}),
				expect.objectContaining({
					run_id: failingRunId,
					interaction_status: "pending",
				}),
			]);
		} finally {
			await sql.unsafe(`
				DROP TRIGGER IF EXISTS test_fail_connection_delete_supersede_trg ON events;
				DROP FUNCTION IF EXISTS test_fail_connection_delete_supersede();
			`);
		}
	});

	it("chat teardown failure leaves the connection visible with approvals still pending", async () => {
		// A chat connection's teardown is a fallible EXTERNAL call. It must run
		// BEFORE approval expiry: if it fails, the connection stays visible and
		// its approvals stay reviewable so the reviewer can still decide (or the
		// user can retry the delete). (RED today: approval expiry commits in a
		// phase BEFORE the teardown, so a failed teardown strands a visible
		// connection with expired approvals.)
		const sql = getTestDb();
		const org = await createTestOrganization({ name: "chat teardown org" });
		const user = await createTestUser();
		const conn = await createTestConnection({
			organization_id: org.id,
			connector_key: "slack",
			created_by: user.id,
		});
		await sql`
			UPDATE connections SET credential_mode = 'managed' WHERE id = ${conn.id}
		`;
		const runId = await seedPendingApprovalRun({
			organizationId: org.id,
			connectionId: conn.id,
			connectorKey: "slack",
			actionKey: "send_message",
		});

		const client = await TestApiClient.for({
			organizationId: org.id,
			userId: user.id,
			memberRole: "owner",
		});
		// The chat-platform teardown fails (no chat manager in the test harness),
		// and the delete surfaces that as an error result.
		await expect(client.connections.delete(conn.id)).rejects.toThrow(
			/chat/i,
		);

		const [row] = await sql`
			SELECT approval_status, status FROM runs WHERE id = ${runId}
		`;
		expect(row.approval_status).toBe("pending");
		expect(row.status).toBe("pending");
		const [connection] = await sql`
			SELECT deleted_at FROM connections WHERE id = ${conn.id}
		`;
		expect(connection.deleted_at).toBeNull();
	});

	it("tombstone write failure rolls back approval expiry (expiry must not precede the tombstone)", async () => {
		// The durable connection tombstone and every pending run/card transition
		// commit ATOMICALLY: if the tombstone write fails, the approvals must not
		// have been expired either. (RED today: expiry commits in its own earlier
		// phase, so a tombstone failure leaves a visible connection whose pending
		// approvals were already burned.)
		const sql = getTestDb();
		const org = await createTestOrganization({ name: "tombstone atomicity org" });
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

		await sql.unsafe(`
			CREATE OR REPLACE FUNCTION test_fail_connection_tombstone()
				RETURNS trigger AS $fn$
			BEGIN
				IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
					RAISE EXCEPTION 'simulated connection tombstone failure';
				END IF;
				RETURN NEW;
			END;
			$fn$ LANGUAGE plpgsql;
			CREATE TRIGGER test_fail_connection_tombstone_trg
				BEFORE UPDATE ON connections
				FOR EACH ROW EXECUTE FUNCTION test_fail_connection_tombstone();
		`);

		try {
			const client = await TestApiClient.for({
				organizationId: org.id,
				userId: user.id,
				memberRole: "owner",
			});
			await expect(client.connections.delete(conn.id)).rejects.toThrow(
				/tombstone failure/i,
			);

			const [connection] = await sql`
				SELECT deleted_at FROM connections WHERE id = ${conn.id}
			`;
			expect(connection.deleted_at).toBeNull();

			const [row] = await sql`
				SELECT approval_status, status FROM runs WHERE id = ${runId}
			`;
			expect(row.approval_status).toBe("pending");
			expect(row.status).toBe("pending");
		} finally {
			await sql.unsafe(`
				DROP TRIGGER IF EXISTS test_fail_connection_tombstone_trg ON connections;
				DROP FUNCTION IF EXISTS test_fail_connection_tombstone();
			`);
		}
	});
});

describe("chat connection delete — teardown + tombstone/approval atomicity", () => {
	// A REAL ChatInstanceManager wired to the Postgres connection/install/secret
	// stores via the gateway test seam, so the actual teardown paths
	// (revokeManagedConnection / removeConnection / deleteSlackInstall) run —
	// the DELETE handler must not hide a chat connection in a separate commit
	// BEFORE the tombstone + pending-approval expiry transaction.
	let manager: ChatInstanceManager;
	let installStore: ReturnType<typeof createPostgresAppInstallationStore>;
	let secretStore: SecretStoreRegistry;

	beforeAll(() => {
		installStore = createPostgresAppInstallationStore();
		const pss = new PostgresSecretStore();
		secretStore = new SecretStoreRegistry(pss, { secret: pss });
		manager = new ChatInstanceManager();
		(manager as unknown as { connectionStore: unknown }).connectionStore =
			createPostgresAgentConnectionStore();
		(manager as unknown as { services: unknown }).services = {
			getSecretStore: () => secretStore,
			getAppInstallationStore: () => installStore,
		};
		// removeConnection's history cleanup goes through a fresh state adapter
		// when no warm instance exists; a connected gateway state is out of scope
		// for this delete-atomicity suite, so stub the seam with a no-op state.
		(manager as unknown as { createStateAdapter: unknown }).createStateAdapter =
			async () => ({
				get: async () => null,
				delete: async () => undefined,
			});
		__setChatInstanceManagerForTests(manager);
	});

	afterAll(() => {
		__setChatInstanceManagerForTests(null);
	});

	async function seedManagedSlackConnection(
		organizationId: string,
	): Promise<number> {
		const installRow = await upsertSlackInstallByTeam(
			installStore,
			secretStore,
			organizationId,
			`T-${randomUUID().slice(0, 8)}`,
			{ teamName: "Atomic Managed", botToken: "xoxb-atomic-managed" },
		);
		const rows = await getTestDb()`
			SELECT id FROM connections
			WHERE organization_id = ${organizationId} AND slug = ${installRow.id}
		`;
		return Number(rows[0].id);
	}

	async function seedByoChatConnection(
		organizationId: string,
		userId: string,
	): Promise<number> {
		const conn = await createTestConnection({
			organization_id: organizationId,
			connector_key: "slack",
			created_by: userId,
		});
		const runtimeId = `byo-atomic-${randomUUID().slice(0, 8)}`;
		await getTestDb()`
			UPDATE connections
			SET credential_mode = 'byo', slug = ${`agentconn-${runtimeId}`}
			WHERE id = ${conn.id}
		`;
		return conn.id;
	}

	/** Force ONLY the delete's approval-card supersede INSERT to fail. */
	async function failDeleteSupersedeFor(
		sql: ReturnType<typeof getTestDb>,
		runId: number,
	): Promise<void> {
		await sql.unsafe(`
			CREATE OR REPLACE FUNCTION test_fail_chat_delete_supersede()
				RETURNS trigger AS $fn$
			BEGIN
				IF NEW.supersedes_event_id IS NOT NULL AND NEW.run_id = ${runId} THEN
					RAISE EXCEPTION 'simulated chat-delete supersede failure';
				END IF;
				RETURN NEW;
			END;
			$fn$ LANGUAGE plpgsql;
			CREATE TRIGGER test_fail_chat_delete_supersede_trg
				BEFORE INSERT ON events
				FOR EACH ROW EXECUTE FUNCTION test_fail_chat_delete_supersede();
		`);
	}

	async function dropDeleteSupersedeTrigger(
		sql: ReturnType<typeof getTestDb>,
	): Promise<void> {
		await sql.unsafe(`
			DROP TRIGGER IF EXISTS test_fail_chat_delete_supersede_trg ON events;
			DROP FUNCTION IF EXISTS test_fail_chat_delete_supersede();
		`);
	}

	async function assertConnectionVisibleWithPendingApproval(
		connectionId: number,
		runId: number,
		organizationId: string,
	): Promise<void> {
		const sql = getTestDb();
		const [connection] = await sql`
			SELECT deleted_at FROM connections WHERE id = ${connectionId}
		`;
		expect(connection.deleted_at).toBeNull();
		const [row] = await sql`
			SELECT approval_status, status FROM runs WHERE id = ${runId}
		`;
		expect(row.approval_status).toBe("pending");
		expect(row.status).toBe("pending");
		const [card] = await sql`
			SELECT interaction_status FROM current_event_records
			WHERE run_id = ${runId} AND organization_id = ${organizationId}
			  AND interaction_type = 'approval'
		`;
		expect(card?.interaction_status).toBe("pending");
	}

	it("managed chat: a teardown success + forced approval-card failure leaves the connection visible with approvals pending", async () => {
		// The managed teardown (deleteSlackInstall → revokeManagedConnection)
		// must NOT soft-delete the `connections` row by itself: the tombstone has
		// to commit atomically with the pending-approval expiry. RED today: the
		// teardown tombstones first, so the approval-card failure leaves a hidden
		// connection (deleted_at set) with its approvals still pending.
		const sql = getTestDb();
		const org = await createTestOrganization({ name: "managed chat atomicity" });
		const user = await createTestUser();
		const connectionId = await seedManagedSlackConnection(org.id);
		const runId = await seedPendingApprovalRun({
			organizationId: org.id,
			connectionId,
			connectorKey: "slack",
			actionKey: "send_message",
		});

		await failDeleteSupersedeFor(sql, runId);
		try {
			const client = await TestApiClient.for({
				organizationId: org.id,
				userId: user.id,
				memberRole: "owner",
			});
			await expect(client.connections.delete(connectionId)).rejects.toThrow(
				/supersede failure/i,
			);
			await assertConnectionVisibleWithPendingApproval(
				connectionId,
				runId,
				org.id,
			);
		} finally {
			await dropDeleteSupersedeTrigger(sql);
		}
	});

	it("managed chat: the same atomicity holds for a forced tombstone write failure", async () => {
		// Tombstone-write failure variant: the connection must stay visible and
		// its approval must stay pending — the teardown may not pre-hide it.
		const sql = getTestDb();
		const org = await createTestOrganization({ name: "managed chat tombstone" });
		const user = await createTestUser();
		const connectionId = await seedManagedSlackConnection(org.id);
		const runId = await seedPendingApprovalRun({
			organizationId: org.id,
			connectionId,
			connectorKey: "slack",
			actionKey: "send_message",
		});

		await sql.unsafe(`
			CREATE OR REPLACE FUNCTION test_fail_chat_delete_tombstone()
				RETURNS trigger AS $fn$
			BEGIN
				IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
					RAISE EXCEPTION 'simulated chat tombstone failure';
				END IF;
				RETURN NEW;
			END;
			$fn$ LANGUAGE plpgsql;
			CREATE TRIGGER test_fail_chat_delete_tombstone_trg
				BEFORE UPDATE ON connections
				FOR EACH ROW EXECUTE FUNCTION test_fail_chat_delete_tombstone();
		`);
		try {
			const client = await TestApiClient.for({
				organizationId: org.id,
				userId: user.id,
				memberRole: "owner",
			});
			await expect(client.connections.delete(connectionId)).rejects.toThrow(
				/tombstone failure/i,
			);
			await assertConnectionVisibleWithPendingApproval(
				connectionId,
				runId,
				org.id,
			);
		} finally {
			await sql.unsafe(`
				DROP TRIGGER IF EXISTS test_fail_chat_delete_tombstone_trg ON connections;
				DROP FUNCTION IF EXISTS test_fail_chat_delete_tombstone();
			`);
		}
	});

	it("byo chat: a teardown success + forced approval-card failure leaves the connection visible with approvals pending", async () => {
		// BYO teardown (removeConnection) must likewise not soft-delete the
		// `connections` row before the atomic phase. RED today: the teardown's
		// connectionStore.deleteConnection tombstones first, so the approval-card
		// failure leaves a hidden connection with its approvals still pending.
		const sql = getTestDb();
		const org = await createTestOrganization({ name: "byo chat atomicity" });
		const user = await createTestUser();
		const connectionId = await seedByoChatConnection(org.id, user.id);
		const runId = await seedPendingApprovalRun({
			organizationId: org.id,
			connectionId,
			connectorKey: "slack",
			actionKey: "send_message",
		});

		await failDeleteSupersedeFor(sql, runId);
		try {
			const client = await TestApiClient.for({
				organizationId: org.id,
				userId: user.id,
				memberRole: "owner",
			});
			await expect(client.connections.delete(connectionId)).rejects.toThrow(
				/supersede failure/i,
			);
			await assertConnectionVisibleWithPendingApproval(
				connectionId,
				runId,
				org.id,
			);
		} finally {
			await dropDeleteSupersedeTrigger(sql);
		}
	});
});
