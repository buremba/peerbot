import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import { loadMigrationUpSection } from "../../../db/migration-loader";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase } from "../../setup/test-db";
import {
	createTestAgent,
	createTestConnection,
	createTestOrganization,
	seedOwnerContext,
} from "../../setup/test-fixtures";

const MIGRATION = "20260717123000_behavior_channel_subscriptions.sql";

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

describe("Behavior channel-subscription migration", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
		await cleanupTestDatabase();
	});

	afterAll(async () => {
		await cleanupTestDatabase();
	});

	it("backfills a legacy binding into one canonical Behavior and drops the state table", async () => {
		const { org, user } = await seedOwnerContext();
		const foreignOrg = await createTestOrganization({
			name: "Foreign migration transcript",
		});
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
			agentId: "migration-agent",
		});
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: "slack",
			created_by: user.id,
			slug: "slackinst-migration",
		});
		const upSection = loadMigrationUpSection(resolveMigrationsDir(), MIGRATION);
		const sql = getDb();
		let captured:
			| {
					legacyTable: string | null;
					compatView: string | null;
					triggers: unknown;
					tagged: boolean;
					executionConfig: unknown;
			  }
			| undefined;

		try {
			await sql.begin(async (tx: typeof sql) => {
				await tx`
					INSERT INTO channel_messages (
						organization_id, connection_id, platform, channel_id,
						platform_message_id, team_id, is_bot, text, occurred_at
					) VALUES
					(
						${org.id}, 'slackinst-migration', 'slack', 'C-MIGRATION',
						'migration-message', 'T-MIGRATION', false, 'hello',
						NOW() - INTERVAL '1 minute'
					),
					(
						${foreignOrg.id}, 'slackinst-migration', 'slack', 'C-MIGRATION',
						'foreign-message', 'T-FOREIGN', false, 'foreign', NOW()
					)
				`;
				await tx.unsafe(`
					CREATE TABLE agent_channel_bindings (
						agent_id text NOT NULL,
						platform text NOT NULL,
						channel_id text NOT NULL,
						team_id text,
						created_at timestamptz DEFAULT now() NOT NULL,
						organization_id text NOT NULL,
						connection_id bigint,
						model text
					)
				`);
				await tx`
					INSERT INTO agent_channel_bindings (
						organization_id, agent_id, platform, channel_id,
						team_id, connection_id, model
					) VALUES (
						${org.id}, ${agent.agentId}, 'slack', 'slack:C-MIGRATION',
						'E-MIGRATION', ${connection.id}, 'anthropic/claude-sonnet'
					)
				`;

				await tx.unsafe(upSection);

				const [behavior] = await tx<{
					triggers: unknown;
					tagged: boolean;
					execution_config: unknown;
				}>`
					SELECT
						triggers,
						tags @> ARRAY['system:chat-link']::text[] AS tagged,
						execution_config
					FROM watchers
					WHERE organization_id = ${org.id}
					  AND agent_id = ${agent.agentId}
					  AND tags @> ARRAY['system:chat-link']::text[]
				`;
				const [legacy] = await tx<{ name: string | null }>`
					SELECT to_regclass('public.agent_channel_bindings')::text AS name
				`;
				const [compatView] = await tx<{ name: string | null }>`
					SELECT to_regclass('public.behavior_channel_subscriptions')::text AS name
				`;
				captured = {
					legacyTable: legacy.name,
					compatView: compatView.name,
					triggers: behavior.triggers,
					tagged: behavior.tagged,
					executionConfig: behavior.execution_config,
				};
				throw new Rollback();
			});
		} catch (error) {
			if (!(error instanceof Rollback)) throw error;
		}

		expect(captured).toEqual({
			legacyTable: null,
			compatView: null,
			triggers: [
				{
					kind: "event",
					connector_key: "slack",
					connection_id: connection.id,
					event_types: ["message.created"],
					match: {
						channel_id: "C-MIGRATION",
						team_id: "T-MIGRATION",
					},
					execution: "turn",
					active_run: "steer",
					output: "reply_to_source",
					skip_if_unchanged: false,
				},
			],
			tagged: true,
			executionConfig: { model: "anthropic/claude-sonnet" },
		});
	});
});
