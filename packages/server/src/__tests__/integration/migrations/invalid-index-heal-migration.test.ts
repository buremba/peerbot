import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import {
	executeMigrationSection,
	loadMigrationUp,
} from "../../../db/migration-loader";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase } from "../../setup/test-db";

/**
 * Concurrent CREATE INDEX IF NOT EXISTS silently no-ops when an INVALID
 * leftover of the same name exists (failed prior concurrent build). The INVALID
 * carcass must be dropped by a heal `DO` block that runs immediately before the
 * `transaction:false` CONCURRENTLY build.
 *
 * Two layouts appear in the tree, both exercised here:
 *  - Legacy: the heal lives in its own companion migration applied just before
 *    the build (`files` = [heal, build]).
 *  - Inline: the heal `DO` and the CONCURRENTLY build share one
 *    `transaction:false` file (`files` = [build]). This is the retry-safe
 *    layout — a standalone heal records as applied on first success, so a later
 *    crash of the build leaves an INVALID carcass the retry never clears; the
 *    inline heal re-runs on every attempt. Both runners (scripts/migrate-up.mjs
 *    in prod, db/migration-loader.ts here) split a `transaction:false` body into
 *    top-level statements so CONCURRENTLY is never trapped in an implicit
 *    multi-statement transaction. `files` is applied in order.
 */
const HEAL_MIGRATIONS = [
	{
		files: [
			"20260717121009_behavior_triggers_index_heal.sql",
			"20260717121010_behavior_triggers_index.sql",
		],
		index: "idx_watchers_triggers_gin",
		/** Plain (non-unique) index definition used only to seed an INVALID carcass. */
		seedSql: `
      CREATE INDEX IF NOT EXISTS idx_watchers_triggers_gin
        ON watchers (id)
    `,
	},
	{
		files: [
			"20260717121019_watcher_run_execution_index_heal.sql",
			"20260717121020_watcher_run_execution_index.sql",
		],
		index: "idx_runs_executing_watcher_per_watcher",
		seedSql: `
      CREATE INDEX IF NOT EXISTS idx_runs_executing_watcher_per_watcher
        ON runs (id)
    `,
	},
	{
		files: [
			"20260717121024_pending_non_event_watcher_run_index_heal.sql",
			"20260717121025_pending_non_event_watcher_run_index.sql",
		],
		index: "idx_runs_pending_non_event_watcher_per_watcher",
		seedSql: `
      CREATE INDEX IF NOT EXISTS idx_runs_pending_non_event_watcher_per_watcher
        ON runs (id)
    `,
	},
	{
		files: [
			"20260719115959_channel_messages_org_dedupe_heal.sql",
			"20260719120000_channel_messages_org_dedupe.sql",
		],
		index: "channel_messages_org_dedup",
		seedSql: `
      CREATE INDEX IF NOT EXISTS channel_messages_org_dedup
        ON channel_messages (id)
    `,
	},
	{
		// Inline heal + build in one transaction:false file (retry-safe layout).
		files: ["20260721120020_connector_versions_org_unique.sql"],
		index: "connector_versions_org_key_version",
		seedSql: `
      CREATE INDEX IF NOT EXISTS connector_versions_org_key_version
        ON connector_versions (id)
    `,
	},
	{
		// Inline heal + build in one transaction:false file (retry-safe layout).
		files: ["20260721120030_connector_versions_shared_unique.sql"],
		index: "connector_versions_shared_key_version",
		seedSql: `
      CREATE INDEX IF NOT EXISTS connector_versions_shared_key_version
        ON connector_versions (id)
    `,
	},
	{
		// Inline heal + build before retiring the weaker preview-slot index.
		files: ["20260801150000_preview_connection_workspace_scope.sql"],
		index: "uniq_preview_connection_per_platform_all",
		seedSql: `
      CREATE INDEX IF NOT EXISTS uniq_preview_connection_per_platform_all
        ON connections (id)
    `,
	},
] as const;

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

async function indexValidity(
	indexName: string,
): Promise<{ exists: boolean; valid: boolean | null }> {
	const sql = getDb();
	const [row] = await sql<{ exists: boolean; valid: boolean | null }>`
    SELECT
      EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = ${indexName}
      ) AS exists,
      (
        SELECT i.indisvalid
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = ${indexName}
      ) AS valid
  `;
	return row ?? { exists: false, valid: null };
}

describe("INVALID concurrent-index heal in transaction:false migrations", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
		await cleanupTestDatabase();
	});

	afterAll(async () => {
		await cleanupTestDatabase();
	});

	it.each(HEAL_MIGRATIONS)(
		"replays $files over an INVALID $index and leaves a VALID index",
		async ({ files, index, seedSql }) => {
			const migrationsDir = resolveMigrationsDir();
			const sql = getDb();

			// Drop any live index from prior suite setup, then seed a same-named
			// INVALID carcass the way a crashed CREATE INDEX CONCURRENTLY would.
			await sql.unsafe(`DROP INDEX IF EXISTS public.${index}`);
			await sql.unsafe(seedSql);
			await sql.unsafe(`
        UPDATE pg_index
        SET indisvalid = false
        WHERE indexrelid = (
          SELECT c.oid
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname = '${index}'
        )
      `);

			const before = await indexValidity(index);
			expect(before).toEqual({ exists: true, valid: false });

			// Apply the pair in order: the companion heal migration drops the
			// INVALID carcass, then the transaction:false migration rebuilds it
			// CONCURRENTLY. Statement-at-a-time mirrors the runtime runner.
			for (const file of files) {
				const up = loadMigrationUp(migrationsDir, file);
				await executeMigrationSection(
					(statement) => sql.unsafe(statement),
					up,
				);
			}

			const after = await indexValidity(index);
			expect(after).toEqual({ exists: true, valid: true });
		},
	);
});
