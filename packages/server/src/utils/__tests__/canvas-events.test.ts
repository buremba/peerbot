import { beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "../../db/client";
import {
	cleanupTestDatabase,
	getTestDb,
} from "../../__tests__/setup/test-db";
import { createTestEntity } from "../../__tests__/setup/test-fixtures";
import { TestWorkspace } from "../../__tests__/setup/test-mcp-client";
import {
	AUTOMATION_CANVAS_NAMESPACE,
	ensureCanvasEntity,
} from "../canvas-events";

/**
 * Wait until the losing transaction has passed its empty identity fast-path
 * and is blocked behind the winner's canvas-type upsert. Releasing the winner
 * earlier can let the loser observe the committed identity and skip the
 * provisional entity path this test exists to prove.
 */
async function waitForBlockedCanvasTypeUpsert(
	sql: ReturnType<typeof getTestDb>,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const rows = await sql<{ count: number }>`
			SELECT count(*)::int AS count
			FROM pg_stat_activity
			WHERE datname = current_database()
				AND wait_event_type = 'Lock'
				AND query ILIKE '%INSERT INTO entity_types%'
		`;
		if (Number(rows[0].count) > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("the losing canvas transaction never reached the type-upsert lock");
}

describe("canvas entity materialization", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("deletes a provisional canvas when a stale parent loses the identity race", async () => {
		const sql = getTestDb();
		const workspace = await TestWorkspace.create({ name: "Canvas race" });
		const parentA = await createTestEntity({
			name: "Current parent",
			organization_id: workspace.org.id,
			created_by: workspace.users.owner.id,
		});
		const parentB = await createTestEntity({
			name: "Stale parent",
			organization_id: workspace.org.id,
			created_by: workspace.users.owner.id,
		});
		const automationId = 7001;
		const ensure = (tx: DbClient, parentEntityId: number) =>
			ensureCanvasEntity({
				tx,
				automationId,
				organizationId: workspace.org.id,
				parentEntityId,
				createdBy: workspace.users.owner.id,
			});

		let signalWinnerReady!: () => void;
		const winnerReady = new Promise<void>((resolve) => {
			signalWinnerReady = resolve;
		});
		let releaseWinner!: () => void;
		const winnerMayCommit = new Promise<void>((resolve) => {
			releaseWinner = resolve;
		});

		const winnerRun = sql.begin(async (tx) => {
			const entityId = await ensure(tx, parentA.id);
			signalWinnerReady();
			await winnerMayCommit;
			return entityId;
		});
		await winnerReady;

		const loserRun = sql.begin((tx) => ensure(tx, parentB.id));
		try {
			await waitForBlockedCanvasTypeUpsert(sql);
		} finally {
			releaseWinner();
		}
		const [winnerId, loserResult] = await Promise.all([winnerRun, loserRun]);

		expect(winnerId).not.toBeNull();
		expect(loserResult).toBe(winnerId);
		const entities = await sql<{ id: number; parent_id: number | null }>`
			SELECT id, parent_id
			FROM entities
			WHERE organization_id = ${workspace.org.id}
				AND metadata->>'source' = 'automation_canvas'
				AND (metadata->>'automation_id')::bigint = ${automationId}
		`;
		expect(entities).toEqual([{ id: winnerId, parent_id: parentA.id }]);
		const claims = await sql<{ entity_id: number }>`
			SELECT entity_id
			FROM entity_identities
			WHERE organization_id = ${workspace.org.id}
				AND namespace = ${AUTOMATION_CANVAS_NAMESPACE}
				AND identifier = ${String(automationId)}
				AND deleted_at IS NULL
		`;
		expect(claims).toEqual([{ entity_id: winnerId }]);
	});
});
