import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase } from "../../setup/test-db";
import {
	createTestAgent,
	createTestOrganization,
} from "../../setup/test-fixtures";

async function runMigrationUp(): Promise<void> {
	const migration = await readFile(
		new URL(
			"../../../../../../db/migrations/20260724170000_inherit_agent_id_from_superseded_slack_connections.sql",
			import.meta.url,
		),
		"utf8",
	);
	const start = migration.indexOf("-- migrate:up");
	const end = migration.indexOf("-- migrate:down");
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	await getDb().unsafe(migration.slice(start + "-- migrate:up".length, end));
}

async function insertConnection(opts: {
	organizationId: string;
	slug: string;
	tenantId: string;
	agentId?: string | null;
	enterpriseId?: string;
	deleted?: boolean;
	/**
	 * `status` for a tombstoned row. Historical retires set `deleted_at` WITHOUT
	 * demoting `status`, so a tombstoned donor can still read 'active' (prod:
	 * conn 430). Defaults to the modern 'paused'.
	 */
	deletedStatus?: "paused" | "active";
}): Promise<number> {
	const rows = await getDb()`
		INSERT INTO connections (
			organization_id, connector_key, external_tenant_id, agent_id,
			display_name, status, config, credential_mode, slug, visibility,
			deleted_at
		) VALUES (
			${opts.organizationId}, 'slack', ${opts.tenantId}, ${opts.agentId ?? null},
			'Grid install', ${opts.deleted ? (opts.deletedStatus ?? "paused") : "active"},
			${getDb().json({
				chatMetadata: {
					teamId: opts.tenantId,
					...(opts.enterpriseId ? { enterpriseId: opts.enterpriseId } : {}),
				},
			})},
			'managed', ${opts.slug}, 'org', ${opts.deleted ? new Date() : null}
		)
		RETURNING id
	`;
	return Number(rows[0].id);
}

async function insertActiveInstall(opts: {
	organizationId: string;
	slug: string;
	tenantId: string;
	enterpriseId: string;
}): Promise<void> {
	await getDb()`
		INSERT INTO app_installations (
			organization_id, provider, provider_app_id, external_tenant_id,
			status, metadata
		) VALUES (
			${opts.organizationId}, 'slack', ${`A_${opts.slug}`}, ${opts.tenantId},
			'active',
			${getDb().json({
				external_id: opts.slug,
				enterprise_id: opts.enterpriseId,
			})}
		)
	`;
}

async function agentIdOf(connectionId: number): Promise<string | null> {
	const rows = await getDb()<{ agent_id: string | null }[]>`
		SELECT agent_id FROM connections WHERE id = ${connectionId}
	`;
	return rows[0]?.agent_id ?? null;
}

describe("inherit agent_id from superseded Slack connection migration", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	afterAll(async () => {
		await cleanupTestDatabase();
	});

	it("repairs one verified donor-successor pair idempotently", async () => {
		const org = await createTestOrganization();
		const agent = await createTestAgent({ organizationId: org.id });
		const enterpriseId = "E_MIGRATION_INHERIT";
		await insertConnection({
			organizationId: org.id,
			slug: "slackinst-migration-dead",
			tenantId: enterpriseId,
			agentId: agent.agentId,
			deleted: true,
		});
		const successor = await insertConnection({
			organizationId: org.id,
			slug: "slackinst-migration-live",
			tenantId: "T_MIGRATION_INHERIT",
			enterpriseId,
		});
		await insertActiveInstall({
			organizationId: org.id,
			slug: "slackinst-migration-live",
			tenantId: "T_MIGRATION_INHERIT",
			enterpriseId,
		});

		await runMigrationUp();
		await runMigrationUp();

		expect(await agentIdOf(successor)).toBe(agent.agentId);
	});

	it("repairs a donor tombstoned WITHOUT being demoted (status still 'active')", async () => {
		// The prod shape this migration exists for: conn 430 carries
		// `deleted_at` yet `status = 'active'`, because it was retired before the
		// supersede demoted `status` alongside the tombstone. A donor filter that
		// also requires `status = 'paused'` matches nothing here — the migration
		// silently no-ops on the only row it was written to fix.
		const org = await createTestOrganization();
		const agent = await createTestAgent({ organizationId: org.id });
		const enterpriseId = "E_MIGRATION_ACTIVE_TOMB";
		await insertConnection({
			organizationId: org.id,
			slug: "slackinst-active-tomb-dead",
			tenantId: enterpriseId,
			agentId: agent.agentId,
			deleted: true,
			deletedStatus: "active",
		});
		const successor = await insertConnection({
			organizationId: org.id,
			slug: "slackinst-active-tomb-live",
			tenantId: "T_MIGRATION_ACTIVE_TOMB",
			enterpriseId,
		});
		await insertActiveInstall({
			organizationId: org.id,
			slug: "slackinst-active-tomb-live",
			tenantId: "T_MIGRATION_ACTIVE_TOMB",
			enterpriseId,
		});

		await runMigrationUp();

		expect(await agentIdOf(successor)).toBe(agent.agentId);
	});

	it("does not donate from an install deleted long before the successor existed", async () => {
		// Causal provenance: a deliberately deleted old install must NOT hand its
		// routing to an unrelated workspace installed later. Only a donor retired
		// BY this successor's arrival is a real supersede.
		const org = await createTestOrganization();
		const agent = await createTestAgent({ organizationId: org.id });
		const enterpriseId = "E_MIGRATION_STALE_DONOR";
		const donor = await insertConnection({
			organizationId: org.id,
			slug: "slackinst-stale-donor",
			tenantId: enterpriseId,
			agentId: agent.agentId,
			deleted: true,
		});
		const successor = await insertConnection({
			organizationId: org.id,
			slug: "slackinst-much-later-live",
			tenantId: "T_MIGRATION_STALE_DONOR",
			enterpriseId,
		});
		await insertActiveInstall({
			organizationId: org.id,
			slug: "slackinst-much-later-live",
			tenantId: "T_MIGRATION_STALE_DONOR",
			enterpriseId,
		});
		// The donor died months BEFORE this workspace was ever created.
		await getDb()`
			UPDATE connections SET deleted_at = now() - interval '90 days'
			WHERE id = ${donor}
		`;
		await getDb()`
			UPDATE connections SET created_at = now() WHERE id = ${successor}
		`;

		await runMigrationUp();

		expect(await agentIdOf(successor)).toBeNull();
	});

	it("does not overwrite existing routing or use a donor with an active install", async () => {
		const org = await createTestOrganization();
		const donorAgent = await createTestAgent({ organizationId: org.id });
		const liveAgent = await createTestAgent({ organizationId: org.id });
		const backedEnterpriseId = "E_MIGRATION_BACKED";
		await insertConnection({
			organizationId: org.id,
			slug: "slackinst-backed-donor",
			tenantId: backedEnterpriseId,
			agentId: donorAgent.agentId,
			deleted: true,
		});
		await insertActiveInstall({
			organizationId: org.id,
			slug: "slackinst-backed-donor",
			tenantId: backedEnterpriseId,
			enterpriseId: backedEnterpriseId,
		});
		const unboundSuccessor = await insertConnection({
			organizationId: org.id,
			slug: "slackinst-unbound-live",
			tenantId: "T_MIGRATION_UNBOUND",
			enterpriseId: backedEnterpriseId,
		});
		await insertActiveInstall({
			organizationId: org.id,
			slug: "slackinst-unbound-live",
			tenantId: "T_MIGRATION_UNBOUND",
			enterpriseId: backedEnterpriseId,
		});

		const routedEnterpriseId = "E_MIGRATION_ROUTED";
		await insertConnection({
			organizationId: org.id,
			slug: "slackinst-unbacked-donor",
			tenantId: routedEnterpriseId,
			agentId: donorAgent.agentId,
			deleted: true,
		});
		const routedSuccessor = await insertConnection({
			organizationId: org.id,
			slug: "slackinst-routed-live",
			tenantId: "T_MIGRATION_PROVENANCE",
			agentId: liveAgent.agentId,
			enterpriseId: routedEnterpriseId,
		});
		await insertActiveInstall({
			organizationId: org.id,
			slug: "slackinst-routed-live",
			tenantId: "T_MIGRATION_PROVENANCE",
			enterpriseId: routedEnterpriseId,
		});

		await runMigrationUp();

		expect(await agentIdOf(unboundSuccessor)).toBeNull();
		expect(await agentIdOf(routedSuccessor)).toBe(liveAgent.agentId);
	});

	it("leaves multiple possible workspace successors unbound", async () => {
		const org = await createTestOrganization();
		const agent = await createTestAgent({ organizationId: org.id });
		const enterpriseId = "E_MIGRATION_AMBIGUOUS";
		await insertConnection({
			organizationId: org.id,
			slug: "slackinst-ambiguous-dead",
			tenantId: enterpriseId,
			agentId: agent.agentId,
			deleted: true,
		});
		const successors: number[] = [];
		for (const teamId of ["T_MIGRATION_ONE", "T_MIGRATION_TWO"]) {
			const slug = `slackinst-${teamId.toLowerCase()}`;
			successors.push(
				await insertConnection({
					organizationId: org.id,
					slug,
					tenantId: teamId,
					enterpriseId,
				}),
			);
			await insertActiveInstall({
				organizationId: org.id,
				slug,
				tenantId: teamId,
				enterpriseId,
			});
		}

		await runMigrationUp();

		expect(await Promise.all(successors.map(agentIdOf))).toEqual([null, null]);
	});
});
