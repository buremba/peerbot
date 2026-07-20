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
 * leftover of the same name exists (failed prior concurrent build). These
 * migrations heal by dropping INVALID carcasses before CREATE CONCURRENTLY.
 */
const HEAL_MIGRATIONS = [
	{
		file: "20260717121010_behavior_triggers_index.sql",
		index: "idx_watchers_triggers_gin",
		/** Plain (non-unique) index definition used only to seed an INVALID carcass. */
		seedSql: `
      CREATE INDEX IF NOT EXISTS idx_watchers_triggers_gin
        ON watchers (id)
    `,
	},
	{
		file: "20260717121020_watcher_run_execution_index.sql",
		index: "idx_runs_executing_watcher_per_watcher",
		seedSql: `
      CREATE INDEX IF NOT EXISTS idx_runs_executing_watcher_per_watcher
        ON runs (id)
    `,
	},
	{
		file: "20260717121025_pending_non_event_watcher_run_index.sql",
		index: "idx_runs_pending_non_event_watcher_per_watcher",
		seedSql: `
      CREATE INDEX IF NOT EXISTS idx_runs_pending_non_event_watcher_per_watcher
        ON runs (id)
    `,
	},
	{
		file: "20260719120000_channel_messages_org_dedupe.sql",
		index: "channel_messages_org_dedup",
		seedSql: `
      CREATE INDEX IF NOT EXISTS channel_messages_org_dedup
        ON channel_messages (id)
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
		"replays $file over an INVALID $index and leaves a VALID index",
		async ({ file, index, seedSql }) => {
			const migrationsDir = resolveMigrationsDir();
			const up = loadMigrationUp(migrationsDir, file);
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

			// Statement-at-a-time: DO heal + CREATE INDEX CONCURRENTLY.
			await executeMigrationSection((statement) => sql.unsafe(statement), up);

			const after = await indexValidity(index);
			expect(after).toEqual({ exists: true, valid: true });
		},
	);
});
