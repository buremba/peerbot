/**
 * `GET /api/:orgSlug/behaviors/windows/:windowId` must speak the public
 * Behavior vocabulary.
 *
 * The handler selects `iw.watcher_id`, `i.slug as watcher_slug` and
 * `i.name as watcher_name` — sanctioned INTERNAL names (the table is still
 * `watchers`) — and used to `c.json(row)` the raw result. That leaked
 * `watcher_*` keys on a public org route while every sibling surface
 * (get_behavior, MCP list/get, SDK, generated client types) emits `behavior_*`.
 *
 * The rename belongs at the wire boundary, not in the SQL, so this pins the
 * response shape rather than the query.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { manageBehaviors } from "../../../tools/admin/manage_behaviors";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestAccessToken,
	createTestAgent,
	createTestEntity,
	createTestOAuthClient,
	seedOwnerContext,
} from "../../setup/test-fixtures";
import { get } from "../../setup/test-helpers";

describe("REST behavior window vocabulary", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("returns behavior_* keys and no watcher_* keys", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const created = (await manageBehaviors(
			{
				action: "create",
				slug: "window-vocab",
				name: "Window vocab",
				prompt: "Summarize.",
				agent_id: agent.agentId,
				sources: [
					{
						name: "src",
						query: "SELECT id FROM events WHERE connector_key = 'none'",
					},
				],
			},
			{} as Env,
			ctx,
		)) as { action?: string; behavior_id?: number | string };

		if (created.action !== "create" || !("behavior_id" in created)) {
			throw new Error("Behavior creation did not complete");
		}
		const behaviorId = Number(created.behavior_id);
		expect(Number.isFinite(behaviorId)).toBe(true);

		const sql = getTestDb();
		// The route inner-joins `entities e ON e.id = ANY(i.entity_ids)`, so an
		// org-scoped Behavior (entity_ids = {}) resolves no row and 404s. Bind one.
		const entity = await createTestEntity({
			name: "Window Vocab Co",
			organization_id: org.id,
		});
		// postgres.js runs fetch_types:false here, so a raw JS array binds to a
		// malformed array literal — build the value in SQL instead.
		await sql`
			UPDATE watchers
			SET entity_ids = ARRAY[${entity.id}::bigint]
			WHERE id = ${behaviorId}
		`;

		// `canvas_windows` is a VIEW over `events` (canvas-on-events): a window is
		// a `canvas_state` root event — no supersedes_event_id — whose metadata
		// carries watcher_id/granularity/window_start.
		const windowRows = (await sql`
			INSERT INTO events
				(organization_id, payload_type, payload_data, semantic_type, created_at, metadata)
			VALUES (
				${org.id},
				'text',
				${sql.json({ summary: "window" })},
				'canvas_state',
				NOW(),
				${sql.json({
					watcher_id: behaviorId,
					granularity: "day",
					window_start: new Date(Date.now() - 86_400_000).toISOString(),
					window_end: new Date().toISOString(),
				})}
			)
			RETURNING id
		`) as Array<{ id: number }>;
		const windowId = windowRows[0].id;

		const client = await createTestOAuthClient({ client_name: "Test" });
		const login = await createTestAccessToken(user.id, org.id, client.client_id, {
			scope: "mcp:read mcp:write",
		});

		const response = await get(
			`/api/${org.slug}/behaviors/windows/${windowId}`,
			{ token: login.token },
		);
		expect(response.status).toBe(200);

		const body = (await response.json()) as Record<string, unknown>;
		expect(body).not.toHaveProperty("watcher_id");
		expect(body).not.toHaveProperty("watcher_slug");
		expect(body).not.toHaveProperty("watcher_name");
		expect(String(body.behavior_id)).toBe(String(behaviorId));
		expect(body.behavior_slug).toBe("window-vocab");
		expect(body.behavior_name).toBe("Window vocab");
	});
});
