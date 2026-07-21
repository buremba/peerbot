/**
 * list_installed must default to a compact projection.
 *
 * The connector projection inlined every connector's auth/feeds/actions/options
 * schema unconditionally — 100KB+ for a full org when a caller only wanted to
 * know what is installed. `detail: 'summary'` (the new default) omits those
 * blobs; `detail: 'full'` restores them.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { listOrgInstalled } from "../../catalog/installed";
import type { ToolContext } from "../../tools/registry";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnectorDefinition,
	seedOwnerContext,
} from "../setup/test-fixtures";

const CONNECTOR_KEY = "demo.catalog.detail";

describe("list_installed detail projection", () => {
	let orgId: string;
	let ctx: ToolContext;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const { org, ctx: ownerCtx } = await seedOwnerContext({
			orgName: "Catalog Detail Org",
		});
		orgId = org.id;
		ctx = ownerCtx;

		await createTestConnectorDefinition({
			key: CONNECTOR_KEY,
			name: "Detail Demo",
			organization_id: orgId,
			auth_schema: { methods: [{ type: "oauth", provider: "test" }] },
		});
		const sql = getTestDb();
		await sql`
			UPDATE connector_definitions
			SET feeds_schema = ${sql.json({ events: { key: "events" } })},
			    actions_schema = ${sql.json({ do_it: { key: "do_it", name: "Do it" } })},
			    options_schema = ${sql.json({ type: "object" })}
			WHERE organization_id = ${orgId} AND key = ${CONNECTOR_KEY}
		`;
	});

	function connectorDetail(
		installed: Awaited<ReturnType<typeof listOrgInstalled>>,
	): Record<string, unknown> {
		const items = (installed.connectors?.items ?? []) as Array<{
			id: string;
			detail: Record<string, unknown>;
		}>;
		const item = items.find((i) => i.id === CONNECTOR_KEY);
		if (!item) throw new Error("connector not in installed list");
		return item.detail;
	}

	const SCHEMA_KEYS = [
		"auth_schema",
		"feeds_schema",
		"actions_schema",
		"options_schema",
	];

	it("summary (default) omits the schema blobs but keeps identity + capability flags", async () => {
		const installed = await listOrgInstalled(orgId, ["connectors"], ctx);
		const detail = connectorDetail(installed);
		for (const key of SCHEMA_KEYS) {
			expect(detail).not.toHaveProperty(key);
		}
		// capability flags survive
		expect(detail).toHaveProperty("has_operations");
		expect(detail).toHaveProperty("version");
		expect(detail).toHaveProperty("source_uri");
	});

	it("detail: 'full' inlines the schema blobs", async () => {
		const installed = await listOrgInstalled(orgId, ["connectors"], ctx, {
			detail: "full",
		});
		const detail = connectorDetail(installed);
		expect(detail).toHaveProperty("auth_schema");
		expect(detail).toHaveProperty("feeds_schema");
		expect(detail).toHaveProperty("actions_schema");
		expect(detail).toHaveProperty("options_schema");
	});
});
