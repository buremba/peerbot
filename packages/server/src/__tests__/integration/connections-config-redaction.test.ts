import { beforeAll, describe, expect, it } from "vitest";
import { querySql } from "../../tools/admin/query_sql";
import type { ToolContext } from "../../tools/registry";
import { search } from "../../tools/search";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnection,
	createTestEntity,
	seedSystemEntityTypes,
} from "../setup/test-fixtures";
import { TestWorkspace } from "../setup/test-mcp-client";

/**
 * Secrets must never leave the server through a Connection serializer.
 *
 * `connections.config` is written verbatim on the create/update path (it is
 * split by FEED SCOPE, never by secrecy), so any connector option declared
 * `format: "password"` — Slack/Discord bot tokens, webhook bearer tokens,
 * a Postgres DATABASE_URL — lands in the row as plaintext. Both read paths
 * (`handleList`, `handleGet`) select `c.*`, so without redaction the secret is
 * echoed straight back to any caller who can see the connection.
 *
 * These probes are the canaries: each value is a distinctive sentinel, and the
 * assertion is on the SERIALIZED response text, so a leak through any nested
 * shape (config.database.password, config.headers.Authorization, …) trips it
 * regardless of depth.
 */
const SECRET_PROBES = {
	DATABASE_URL: "postgres://u:pw-LEAK-database-url@db.internal:5432/app",
	password: "pw-LEAK-flat-password",
	api_key: "pw-LEAK-api-key",
	refresh_token: "pw-LEAK-refresh-token",
	nested: {
		database: { password: "pw-LEAK-nested-password" },
		headers: { Authorization: "Bearer pw-LEAK-bearer" },
		credentials: { client_secret: "pw-LEAK-client-secret" },
		deep: { a: { b: { c: { session_id: "pw-LEAK-deep-session" } } } },
	},
	cookie: "session=pw-LEAK-cookie",
} as const;

/** Every sentinel value planted above, flattened. */
const LEAK_SENTINELS = [
	"pw-LEAK-database-url",
	"pw-LEAK-flat-password",
	"pw-LEAK-api-key",
	"pw-LEAK-refresh-token",
	"pw-LEAK-nested-password",
	"pw-LEAK-bearer",
	"pw-LEAK-client-secret",
	"pw-LEAK-deep-session",
	"pw-LEAK-cookie",
];

function assertNoSecrets(payload: unknown, label: string): void {
	const serialized = JSON.stringify(payload ?? null);
	for (const sentinel of LEAK_SENTINELS) {
		expect(
			serialized.includes(sentinel),
			`${label} leaked secret sentinel ${sentinel}`,
		).toBe(false);
	}
}

describe("connection config redaction", () => {
	let workspace: TestWorkspace;
	let connectionId: number;
	let entityId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		workspace = await TestWorkspace.create({
			name: "Redaction Org",
			visibility: "public",
		});
		await seedSystemEntityTypes(workspace.org.id);

		entityId = Number(
			(
				await createTestEntity({
					name: "Redaction Probe Co",
					organization_id: workspace.org.id,
					created_by: workspace.users.owner.id,
				})
			).id,
		);

		connectionId = Number(
			(
				await createTestConnection({
					organization_id: workspace.org.id,
					connector_key: "postgres",
					display_name: "Secretful Postgres",
					created_by: workspace.users.owner.id,
					visibility: "org",
					// Tags the connection onto the entity so search_memory's
					// `fetchConnectionsForEntity` picks it up.
					entity_ids: [entityId],
					config: {
						...SECRET_PROBES,
						// A non-secret key must survive redaction untouched —
						// redaction that nukes the whole config is not a fix.
						host: "db.internal",
					},
				})
			).id,
		);

		// `createTestConnection` also creates a 'default' feed. Plant the same
		// probes into ITS config so the feeds arm of the query_sql chokepoint is
		// exercised by a real row rather than an empty result set.
		await getTestDb()`
      UPDATE feeds
      SET config = ${getTestDb().json({ ...SECRET_PROBES, host: "db.internal" })}::jsonb
      WHERE connection_id = ${connectionId}
    `;
	});

	it("does not leak secrets through connections.list()", async () => {
		const result = await workspace.owner.connections.list({});
		assertNoSecrets(result, "connections.list()");
	});

	it("does not leak secrets through connections.get()", async () => {
		const result = await workspace.owner.connections.get(connectionId);
		assertNoSecrets(result, "connections.get()");
	});

	it("preserves non-secret config values", async () => {
		const result = (await workspace.owner.connections.get(connectionId)) as {
			connection?: { config?: Record<string, unknown> };
		};
		expect(result.connection?.config?.host).toBe("db.internal");
	});

	/**
	 * Second leak found in the same audit: `search_memory` embeds the entity's
	 * connections via `fetchConnectionsForEntity`, which selected `c.config`
	 * raw and typed it straight into the tool's output schema — the same
	 * plaintext secrets, on a tool that is publicly readable.
	 */
	it("does not leak secrets through search_memory's entity connections", async () => {
		const ctx = {
			organizationId: workspace.org.id,
			userId: workspace.users.owner.id,
			memberRole: "owner",
			isAuthenticated: true,
			tokenType: "oauth",
			scopedToOrg: false,
			allowCrossOrg: true,
			scopes: ["mcp:read"],
		} as ToolContext;

		const result = await search(
			{ entity_id: entityId, include_connections: true } as never,
			{} as never,
			ctx,
		);
		assertNoSecrets(result, "search_memory(include_connections)");

		// The connection must still be reported — redaction, not suppression.
		const connections = (
			result as { connections?: Array<{ config?: unknown }> }
		).connections;
		expect(connections?.length).toBeGreaterThan(0);
		expect((connections?.[0]?.config as Record<string, unknown>)?.host).toBe(
			"db.internal",
		);
	});

	/**
	 * `create` and `update` echo the row back via `RETURNING *`, so a caller
	 * who POSTs a secret gets it mirrored into the response (and from there
	 * into any log/transcript that captures tool output).
	 */
	it("does not echo secrets back from connections.update()", async () => {
		const result = await workspace.owner.connections.update({
			connection_id: connectionId,
			config: { password: "pw-LEAK-flat-password" },
		});
		assertNoSecrets(result, "connections.update()");
	});

	/**
	 * The widest surface of all: `query_sql` is a top-level, member-safe MCP tool
	 * in every agent's tool set, and `connections` is NOT in
	 * ADMIN_ONLY_QUERYABLE_TABLES — so a plain member (or any agent) could
	 * `SELECT config FROM connections` and read the raw jsonb.
	 *
	 * table-schema.ts is the DESIGNATED chokepoint for this tool and its header
	 * asserted secret columns were "already excluded", but `config` sat in the
	 * connections AND feeds allowlists. Fixed there, so the redaction is applied
	 * in the generated CTE and cannot be bypassed by query shape.
	 */
	it("does not leak secrets to a member through query_sql on connections", async () => {
		const memberCtx = {
			organizationId: workspace.org.id,
			userId: workspace.users.member.id,
			memberRole: "member",
			isAuthenticated: true,
			tokenType: "oauth",
			scopedToOrg: true,
			allowCrossOrg: false,
			scopes: ["mcp:read"],
		} as ToolContext;

		const result = await querySql(
			{ sql: "SELECT id, config FROM connections" } as never,
			{} as never,
			memberCtx,
		);
		assertNoSecrets(result, "query_sql SELECT config FROM connections");

		// The column must still resolve — dropping it would break every legitimate
		// operational query. Non-secret keys survive.
		const rows = (result as { rows?: Array<{ config?: unknown }> }).rows ?? [];
		expect(rows.length).toBeGreaterThan(0);
		expect((rows[0]?.config as Record<string, unknown>)?.host).toBe(
			"db.internal",
		);
	});

	/**
	 * Same chokepoint, the other table: `feeds.config` was allowlisted verbatim
	 * too. No shipped connector is known to place a secret in FEED-scoped config
	 * today (connection-scoped is where credentials land), so this is a latent
	 * hole rather than an active exploit — pinned so it stays closed.
	 */
	it("does not leak secrets to a member through query_sql on feeds", async () => {
		const memberCtx = {
			organizationId: workspace.org.id,
			userId: workspace.users.member.id,
			memberRole: "member",
			isAuthenticated: true,
			tokenType: "oauth",
			scopedToOrg: true,
			allowCrossOrg: false,
			scopes: ["mcp:read"],
		} as ToolContext;

		const result = await querySql(
			{ sql: "SELECT id, config FROM feeds" } as never,
			{} as never,
			memberCtx,
		);
		assertNoSecrets(result, "query_sql SELECT config FROM feeds");
	});
});
