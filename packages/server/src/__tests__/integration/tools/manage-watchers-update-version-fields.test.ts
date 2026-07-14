/**
 * manage_watchers `update` — version-owned fields must not be silently dropped.
 *
 * Bug (red→fix→green): `WATCHER_UPDATE_PATCH_KEYS` advertised `name`,
 * `description`, `prompt`, `sources`, and `entity_ids` as valid
 * `update` patch fields, but `handleUpdate`'s UPDATE SET clause writes none of
 * them — `name`/`description`/`prompt`/`sources` are version-owned (live in
 * `watcher_versions`; the watchers-row `name` is cascaded by version
 * activation), `entity_ids` is `create_from_version`-only. (`status` was also
 * listed but isn't on `ManageWatchersArgs` — it's a `list` filter; the entry
 * was dead.) So an `update` carrying any of them passed validation and
 * returned success with `updated_fields: []` — a silent no-op the caller
 * believed applied.
 *
 * Contract intent (packages/core/src/contracts/tools/manage-watchers.ts):
 *   name/description/prompt → "[create/create_version]"
 *   sources                 → "[create/create_version]" (update was a doc lie)
 *   entity_ids              → "[create_from_version]"
 *
 * Fix: drop those keys from `WATCHER_UPDATE_PATCH_KEYS` AND explicitly reject
 * them on `update` with a pointer to `create_version`, so a caller can never
 * believe a version-owned change applied.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import type { AuthContext } from "../../../tools/execute";
import { executeTool } from "../../../tools/execute";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const TEST_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
	MAX_CONSECUTIVE_FAILURES: "3",
	RATE_LIMIT_ENABLED: "false",
};

describe("manage_watchers update — version-owned fields are not silently dropped", () => {
	let orgId: string;
	let ownerId: string;
	let ownerCtx: AuthContext;
	let agentId: string;
	let watcherId: string;

	const baseCtx = (
		orgIdValue: string,
		userId: string,
	): AuthContext => ({
		organizationId: orgIdValue,
		tokenOrganizationId: orgIdValue,
		userId,
		memberRole: "owner",
		agentId: null,
		requestedAgentId: null,
		isAuthenticated: true,
		clientId: null,
		scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		tokenType: "oauth",
		requestUrl: `http://localhost/api/${orgIdValue}`,
		baseUrl: "",
		scopedToOrg: true,
		allowCrossOrg: false,
	});

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();

		const org = await createTestOrganization({ name: "watcher update fields" });
		orgId = org.id;
		const owner = await createTestUser({ email: "wu-owner@test.com" });
		ownerId = owner.id;
		await addUserToOrganization(owner.id, org.id, "owner");
		ownerCtx = baseCtx(org.id, owner.id);

		const agent = await createTestAgent({
			organizationId: org.id,
			agentId: "wu-agent",
			ownerUserId: owner.id,
		});
		agentId = agent.agentId;

		const created = (await executeTool(
			"manage_watchers",
			{
				action: "create",
				slug: "wu-target",
				name: "Original",
				prompt: "Original prompt.",
				agent_id: agentId,
			},
			TEST_ENV,
			ownerCtx,
		)) as { watcher_id?: string };
		watcherId = created.watcher_id!;
	});

	async function fetchWatcherName(): Promise<string> {
		const sql = getTestDb();
		const rows = await sql`SELECT name FROM watchers WHERE id = ${watcherId}`;
		return (rows[0] as { name: string }).name;
	}

	it("rejects `update` with name only (version-owned) — points to create_version", async () => {
		await expect(
			executeTool(
				"manage_watchers",
				{ action: "update", watcher_id: watcherId, name: "Renamed" },
				TEST_ENV,
				ownerCtx,
			),
		).rejects.toThrow(/create_version/i);
		// Name unchanged — no silent partial apply.
		expect(await fetchWatcherName()).toBe("Original");
	});

	it("rejects `update` with description only — points to create_version", async () => {
		await expect(
			executeTool(
				"manage_watchers",
				{ action: "update", watcher_id: watcherId, description: "New desc" },
				TEST_ENV,
				ownerCtx,
			),
		).rejects.toThrow(/create_version/i);
	});

	it("rejects `update` with prompt only — points to create_version", async () => {
		await expect(
			executeTool(
				"manage_watchers",
				{ action: "update", watcher_id: watcherId, prompt: "New prompt" },
				TEST_ENV,
				ownerCtx,
			),
		).rejects.toThrow(/create_version/i);
	});

	it("rejects `update` with sources only — points to create_version", async () => {
		await expect(
			executeTool(
				"manage_watchers",
				{
					action: "update",
					watcher_id: watcherId,
					sources: [{ name: "content", query: "SELECT 1" }],
				},
				TEST_ENV,
				ownerCtx,
			),
		).rejects.toThrow(/create_version/i);
	});

	it("rejects `update` with name even when a real patch field is also present (no silent drop)", async () => {
		// name + schedule: schedule is valid, but name must NOT be silently
		// dropped — the whole call must reject so the caller learns name needs
		// create_version.
		await expect(
			executeTool(
				"manage_watchers",
				{
					action: "update",
					watcher_id: watcherId,
					name: "Should Not Apply",
					schedule: "0 9 * * *",
				},
				TEST_ENV,
				ownerCtx,
			),
		).rejects.toThrow(/create_version/i);
		expect(await fetchWatcherName()).toBe("Original");
	});

	it("still applies a legitimate update field (schedule) without name", async () => {
		// Control: the reject path must not break real updates.
		const res = (await executeTool(
			"manage_watchers",
			{ action: "update", watcher_id: watcherId, schedule: "0 9 * * *" },
			TEST_ENV,
			ownerCtx,
		)) as { updated_fields?: string[] };
		expect(res.updated_fields).toContain("schedule");
	});

	it("create_version with a new name cascades to the watchers row", async () => {
		// Positive path: the documented way to rename a watcher.
		await executeTool(
			"manage_watchers",
			{
				action: "create_version",
				watcher_id: watcherId,
				name: "Renamed Via Version",
				set_as_current: true,
			},
			TEST_ENV,
			ownerCtx,
		);
		expect(await fetchWatcherName()).toBe("Renamed Via Version");
	});
});
