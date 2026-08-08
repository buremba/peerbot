/**
 * The repair migration's whole risk is its WHERE clause.
 *
 * `UPDATE events SET occurred_at = created_at` is trivially correct on a row
 * that should never have been future-stamped, and destructive on one that
 * should — 35,740 rows repo-wide have `occurred_at > created_at` and the
 * overwhelming majority are CORRECT (calendar events, flights, birthdays).
 * There is no `down`. So what needs proving is not that the UPDATE runs, but
 * that `behavior_id IS NOT NULL AND occurred_at > created_at` selects exactly
 * the broken rows and nothing adjacent to them.
 *
 * Each row below is one way the predicate could be wrong, seeded so that a
 * predicate that over-reaches fails on the row it should not have touched and a
 * predicate that under-reaches fails on the row it should have.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import { loadMigrationUpSection } from "../../../db/migration-loader";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase } from "../../setup/test-db";
import { createTestAgent, seedOwnerContext } from "../../setup/test-fixtures";

const MIGRATION =
	"20260808020000_events_behavior_output_occurred_at_repair.sql";

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

class Rollback extends Error {}

type Row = {
	label: string;
	occurredAt: Date;
	createdAt: Date;
};

describe("Behavior output occurred_at repair migration", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
		await cleanupTestDatabase();
	});

	afterAll(async () => {
		await cleanupTestDatabase();
	});

	it("repairs future-stamped Behavior output and leaves every other future stamp alone", async () => {
		const { org, user } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
			agentId: "occurred-at-repair-agent",
		});
		const up = loadMigrationUpSection(resolveMigrationsDir(), MIGRATION);
		const sql = getDb();

		let rows: Row[] | undefined;
		let secondPassChanged: number | undefined;

		try {
			await sql.begin(async (tx: typeof sql) => {
				const [ids] = await tx<{ watcherId: number }>`
          SELECT (COALESCE(MAX(id), 0) + 1)::int AS "watcherId" FROM watchers
        `;
				const watcherId = ids.watcherId;
				await tx`
          INSERT INTO watchers (
            id, name, slug, organization_id, entity_ids, schedule, timezone,
            next_run_at, agent_id, model_config, sources, version, tags, status,
            created_by, created_at, updated_at, watcher_group_id, triggers
          ) VALUES (
            ${watcherId}, 'Repair fixture', 'repair-fixture',
            ${org.id}, '{}'::bigint[], '0 9 * * *', 'UTC', NOW(),
            ${agent.agentId}, '{}'::jsonb, '[]'::jsonb, 1, '{}'::text[],
            'active', ${user.id}, NOW(), NOW(), ${watcherId}, '[]'::jsonb
          )
        `;

				// created_at is fixed for every row so the assertions compare against
				// one known instant rather than against per-row insert time.
				const writtenAt = new Date("2026-08-01T03:25:00.000Z");
				const seed = async (
					label: string,
					behaviorId: number | null,
					semanticType: string,
					occurredAt: string,
				) => {
					await tx`
            INSERT INTO events (
              entity_ids, origin_id, title, payload_type, payload_text,
              occurred_at, semantic_type, organization_id, created_at, behavior_id
            ) VALUES (
              '{}'::bigint[], ${`repair-${label}`}, ${label}, 'text', ${label},
              ${occurredAt}::timestamptz, ${semanticType}, ${org.id},
              ${writtenAt}::timestamptz, ${behaviorId}
            )
          `;
				};

				// THE TARGET: Behavior output stamped at the daily window end, 20.6h
				// after the run that wrote it. This is the prod signature.
				await seed(
					"window-end",
					watcherId,
					"observation",
					"2026-08-01T23:59:59.000Z",
				);
				// A weekly window — same bug, 6.5 days out. Proves the repair is not
				// scoped to some "within 24h" notion of plausible skew.
				await seed(
					"weekly-window-end",
					watcherId,
					"canvas_state",
					"2026-08-07T15:49:00.000Z",
				);
				// NOT the target: a genuinely future occurrence with no Behavior. This
				// is the row a bare `occurred_at > created_at` predicate would destroy,
				// and there are 223 of them in prod right now.
				await seed(
					"calendar",
					null,
					"calendar_event",
					"2026-09-01T09:00:00.000Z",
				);
				// NOT the target: already correct. Guards the strict `>` — an `>=`
				// would rewrite it to the same value, but a predicate that widened to
				// `<>` would churn it.
				await seed(
					"already-correct",
					watcherId,
					"observation",
					"2026-08-01T03:25:00.000Z",
				);
				// NOT the target: back-dated Behavior output. A Behavior may legitimately
				// stamp a row EARLIER than it wrote it (importing something that already
				// happened); only the future direction is the bug.
				await seed(
					"back-dated",
					watcherId,
					"observation",
					"2026-07-30T12:00:00.000Z",
				);

				await tx.unsafe(up);

				rows = await tx<Row>`
          SELECT title AS label, occurred_at AS "occurredAt", created_at AS "createdAt"
          FROM events WHERE origin_id LIKE 'repair-%' ORDER BY title
        `;

				// Rerunnable: the strict `>` self-clears, so a second application must
				// match nothing. dbmate will not re-run it, but a manual replay or a
				// restored-then-re-migrated database will.
				const again = await tx.unsafe(up);
				secondPassChanged = (again as unknown as { count: number }).count;

				throw new Rollback();
			});
		} catch (error) {
			if (!(error instanceof Rollback)) throw error;
		}

		const byLabel = new Map((rows ?? []).map((r) => [r.label, r]));
		expect([...byLabel.keys()].sort()).toEqual([
			"already-correct",
			"back-dated",
			"calendar",
			"weekly-window-end",
			"window-end",
		]);

		// Repaired: stamp now equals the moment the row was actually written, which
		// is what makes it visible to a read path bounded on `occurred_at <= now()`.
		for (const label of ["window-end", "weekly-window-end"]) {
			const row = byLabel.get(label)!;
			expect(row.occurredAt.toISOString(), `${label} was not repaired`).toBe(
				row.createdAt.toISOString(),
			);
		}

		// Untouched, each for a different reason.
		expect(
			byLabel.get("calendar")!.occurredAt.toISOString(),
			"a genuinely future calendar event was rewritten",
		).toBe("2026-09-01T09:00:00.000Z");
		expect(
			byLabel.get("back-dated")!.occurredAt.toISOString(),
			"back-dated Behavior output was rewritten",
		).toBe("2026-07-30T12:00:00.000Z");
		expect(byLabel.get("already-correct")!.occurredAt.toISOString()).toBe(
			byLabel.get("already-correct")!.createdAt.toISOString(),
		);

		expect(secondPassChanged, "second application was not a no-op").toBe(0);
	});
});
