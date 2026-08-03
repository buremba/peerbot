/**
 * One-shot data migration `20260719122000_cancel_stale_watcher_approval_runs.sql`.
 *
 * Pending internal runs with action_key='manage_watchers' (queued by the removed
 * manage_watchers tool) are terminally rejected so approval cards are dismissable
 * after deploy. Live manage_behaviors pending runs must stay untouched.
 *
 * The test DB already applied all migrations at setup, so this exercises the
 * migration SQL replay path against seeded rows (idempotent / replay-safe).
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadMigrationUpSection } from "../../../db/migration-loader";
import { getTestDb } from "../../setup/test-db";
import { createTestOrganization } from "../../setup/test-fixtures";

const MIGRATION = "20260719122000_cancel_stale_watcher_approval_runs.sql";

function resolveMigrationsDir(): string {
	let dir = __dirname;
	for (let i = 0; i < 8; i++) {
		const candidate = join(dir, "db/migrations");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error("Could not locate db/migrations from the test directory");
}

interface Captured {
	staleAfter: {
		approval_status: string | null;
		status: string;
		error_message: string | null;
		completed_at: Date | null;
	} | null;
	liveAfter: {
		approval_status: string | null;
		status: string;
		error_message: string | null;
		completed_at: Date | null;
	} | null;
	/** Second apply leaves the already-resolved row unchanged. */
	staleAfterReplay: {
		approval_status: string | null;
		status: string;
		error_message: string | null;
	} | null;
}

class Rollback extends Error {}

describe("stale manage_watchers approval-run migration", () => {
	let captured: Captured;

	beforeAll(async () => {
		const org = await createTestOrganization({
			name: "Stale watcher approval migration",
		});
		const sql = getTestDb();
		const upSection = loadMigrationUpSection(resolveMigrationsDir(), MIGRATION);

		const result: Captured = {
			staleAfter: null,
			liveAfter: null,
			staleAfterReplay: null,
		};

		try {
			await sql.begin(async (tx: typeof sql) => {
				const [stale] = await tx<{ id: number }[]>`
					INSERT INTO runs (
						organization_id, run_type, action_key, action_input,
						approval_status, status, created_at
					) VALUES (
						${org.id}, 'internal', 'manage_watchers',
						${tx.json({ action: "create", slug: "legacy-watcher" })},
						'pending', 'pending', current_timestamp
					)
					RETURNING id
				`;
				const [live] = await tx<{ id: number }[]>`
					INSERT INTO runs (
						organization_id, run_type, action_key, action_input,
						approval_status, status, created_at
					) VALUES (
						${org.id}, 'internal', 'manage_behaviors',
						${tx.json({ action: "create", slug: "live-behavior" })},
						'pending', 'pending', current_timestamp
					)
					RETURNING id
				`;

				await tx.unsafe(upSection);

				const [staleRow] = await tx<
					{
						approval_status: string | null;
						status: string;
						error_message: string | null;
						completed_at: Date | null;
					}[]
				>`
					SELECT approval_status, status, error_message, completed_at
					FROM runs WHERE id = ${stale.id}
				`;
				const [liveRow] = await tx<
					{
						approval_status: string | null;
						status: string;
						error_message: string | null;
						completed_at: Date | null;
					}[]
				>`
					SELECT approval_status, status, error_message, completed_at
					FROM runs WHERE id = ${live.id}
				`;
				result.staleAfter = staleRow ?? null;
				result.liveAfter = liveRow ?? null;

				// Replay: WHERE approval_status = 'pending' must match 0 rows.
				await tx.unsafe(upSection);
				const [staleReplay] = await tx<
					{
						approval_status: string | null;
						status: string;
						error_message: string | null;
					}[]
				>`
					SELECT approval_status, status, error_message
					FROM runs WHERE id = ${stale.id}
				`;
				result.staleAfterReplay = staleReplay ?? null;

				throw new Rollback();
			});
		} catch (err) {
			if (!(err instanceof Rollback)) throw err;
		}

		captured = result;
	});

	it("terminally rejects pending internal manage_watchers runs", () => {
		expect(captured.staleAfter).not.toBeNull();
		expect(captured.staleAfter!.approval_status).toBe("rejected");
		expect(captured.staleAfter!.status).toBe("cancelled");
		expect(captured.staleAfter!.error_message).toMatch(/manage_watchers was removed/);
		expect(captured.staleAfter!.completed_at).not.toBeNull();
	});

	it("leaves pending manage_behaviors builder runs untouched", () => {
		expect(captured.liveAfter).not.toBeNull();
		expect(captured.liveAfter!.approval_status).toBe("pending");
		expect(captured.liveAfter!.status).toBe("pending");
		expect(captured.liveAfter!.error_message).toBeNull();
		expect(captured.liveAfter!.completed_at).toBeNull();
	});

	it("is idempotent on replay", () => {
		expect(captured.staleAfterReplay).not.toBeNull();
		expect(captured.staleAfterReplay!.approval_status).toBe("rejected");
		expect(captured.staleAfterReplay!.status).toBe("cancelled");
		expect(captured.staleAfterReplay!.error_message).toBe(
			captured.staleAfter!.error_message,
		);
	});
});
