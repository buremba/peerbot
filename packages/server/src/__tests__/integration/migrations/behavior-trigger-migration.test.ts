import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import {
	loadMigrationDownSection,
	loadMigrationUpSection,
} from "../../../db/migration-loader";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase } from "../../setup/test-db";
import { adaptImmutableMigrationToBehaviorSchema } from "../../setup/immutable-migration";
import { createTestAgent, seedOwnerContext } from "../../setup/test-fixtures";

const TRIGGER_MIGRATION = "20260717121000_behavior_triggers.sql";
const SUBSCRIPTION_MIGRATION =
	"20260717123000_behavior_channel_subscriptions.sql";

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

describe("Behavior trigger migration", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
		await cleanupTestDatabase();
	});

	afterAll(async () => {
		await cleanupTestDatabase();
	});

	it("one-shot backfills schedule triggers and rolls back without dual-write bridges", async () => {
		const { org, user } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
			agentId: "schedule-backfill-agent",
		});
		const migrationsDir = resolveMigrationsDir();
		const up = adaptImmutableMigrationToBehaviorSchema(
			loadMigrationUpSection(migrationsDir, TRIGGER_MIGRATION),
		);
		const down = adaptImmutableMigrationToBehaviorSchema(
			loadMigrationDownSection(migrationsDir, TRIGGER_MIGRATION),
		);
		const subscriptionDown = adaptImmutableMigrationToBehaviorSchema(
			loadMigrationDownSection(migrationsDir, SUBSCRIPTION_MIGRATION),
		);
		const sql = getDb();
		const canonicalWrite = [
			{
				kind: "event",
				connector_key: "github",
				event_types: ["pull_request.created"],
				execution: "turn",
				active_run: "queue",
				output: "silent",
				skip_if_unchanged: true,
			},
			{
				kind: "schedule",
				cron: "30 8 * * *",
				timezone: "UTC",
				execution: "window",
				active_run: "coalesce",
				skip_if_unchanged: true,
			},
		];
		let captured:
			| {
					backfilled: unknown;
					canonical: unknown;
					scheduleOnlyAfterCleanCut: unknown;
					remainingArtifacts: number;
			  }
			| undefined;

		try {
			await sql.begin(async (tx: typeof sql) => {
				// Pre-migration row: schedule columns only (empty triggers).
				const [ids] = await tx<{ behaviorId: number }>`
          SELECT (COALESCE(MAX(id), 0) + 1)::int AS "behaviorId" FROM behaviors
        `;
				const behaviorId = ids.behaviorId;
				await tx`
          INSERT INTO behaviors (
            id, name, slug, organization_id, entity_ids, schedule, timezone,
            next_run_at, agent_id, model_config, sources, version, tags, status,
            created_by, created_at, updated_at, behavior_group_id, triggers
          ) VALUES (
            ${behaviorId}, 'Legacy schedule insert', 'legacy-schedule-insert',
            ${org.id}, '{}'::bigint[], '0 9 * * *', 'Europe/London', NOW(),
            ${agent.agentId}, '{}'::jsonb, '[]'::jsonb, 1, '{}'::text[],
            'active', ${user.id}, NOW(), NOW(), ${behaviorId}, '[]'::jsonb
          )
        `;

				await tx.unsafe(up);
				const [backfilled] = await tx<{ triggers: unknown }>`
          SELECT triggers FROM behaviors WHERE id = ${behaviorId}
        `;

				// App-style canonical write of triggers + schedule projections.
				await tx`
          UPDATE behaviors
          SET schedule = '30 8 * * *', timezone = 'UTC',
              triggers = ${tx.json(canonicalWrite)}
          WHERE id = ${behaviorId}
        `;
				const [canonical] = await tx<{ triggers: unknown }>`
          SELECT triggers FROM behaviors WHERE id = ${behaviorId}
        `;

				// Clean cut: schedule-only updates do NOT rewrite triggers.
				await tx`
          UPDATE behaviors
          SET schedule = '15 7 * * 1', timezone = 'America/New_York'
          WHERE id = ${behaviorId}
        `;
				const [scheduleOnly] = await tx<{ triggers: unknown }>`
          SELECT triggers FROM behaviors WHERE id = ${behaviorId}
        `;

				await tx.unsafe(subscriptionDown);
				await tx.unsafe(down);
				const [artifacts] = await tx<{ count: number }>`
          SELECT (
            SELECT COUNT(*)::int FROM pg_trigger
            WHERE NOT tgisinternal
              AND tgname = 'sync_legacy_behavior_schedule_trigger'
          ) + (
            SELECT COUNT(*)::int FROM pg_proc
            WHERE proname = 'sync_legacy_behavior_schedule_trigger'
          ) AS count
        `;
				captured = {
					backfilled: backfilled.triggers,
					canonical: canonical.triggers,
					scheduleOnlyAfterCleanCut: scheduleOnly.triggers,
					remainingArtifacts: artifacts.count,
				};
				throw new Rollback();
			});
		} catch (error) {
			if (!(error instanceof Rollback)) throw error;
		}

		expect(captured).toEqual({
			backfilled: [
				{
					kind: "schedule",
					cron: "0 9 * * *",
					timezone: "Europe/London",
					execution: "window",
					active_run: "coalesce",
					skip_if_unchanged: false,
				},
			],
			canonical: canonicalWrite,
			// No dual-write: schedule column change left triggers untouched.
			scheduleOnlyAfterCleanCut: canonicalWrite,
			remainingArtifacts: 0,
		});
	});

	it("rejects concurrent pending runs from legacy scheduler replicas", async () => {
		const { org, user } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
			agentId: "legacy-scheduler-race-agent",
		});
		const sql = getDb();
		const [ids] = await sql<{ behaviorId: number }>`
      SELECT (COALESCE(MAX(id), 0) + 1)::int AS "behaviorId" FROM behaviors
    `;
		const behaviorId = ids.behaviorId;
		await sql`
      INSERT INTO behaviors (
        id, name, slug, organization_id, entity_ids, schedule, timezone,
        next_run_at, agent_id, model_config, sources, version, tags, status,
        created_by, created_at, updated_at, behavior_group_id
      ) VALUES (
        ${behaviorId}, 'Legacy scheduler race', 'legacy-scheduler-race',
        ${org.id}, '{}'::bigint[], '0 9 * * *', 'UTC', NOW(),
        ${agent.agentId}, '{}'::jsonb, '[]'::jsonb, 1, '{}'::text[],
        'active', ${user.id}, NOW(), NOW(), ${behaviorId}
      )
    `;

		const insertLegacyRun = (suffix: string) => sql`
      INSERT INTO runs (
        organization_id, run_type, behavior_id, approval_status, status,
        approved_input, idempotency_key, created_at
      ) VALUES (
        ${org.id}, 'behavior', ${behaviorId}, 'auto', 'pending',
        ${sql.json({ behavior_id: behaviorId, agent_id: agent.agentId })},
        ${`legacy-scheduler-race:${suffix}`}, NOW()
      )
      RETURNING id
    `;
		const results = await Promise.allSettled([
			insertLegacyRun("one"),
			insertLegacyRun("two"),
		]);

		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected?.status).toBe("rejected");
		if (rejected?.status === "rejected") {
			expect((rejected.reason as { code?: string }).code).toBe("23505");
		}
	});
});
