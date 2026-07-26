import { REDACTED_SENTINEL } from "@lobu/core";
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

/**
 * `manage_feeds` serializes `f.*`, which carries two columns that must not
 * reach a caller:
 *
 *  - `checkpoint` — the connector's opaque sync cursor. `table-schema.ts`
 *    already names it as a column query_sql must never emit; these tools should
 *    not be a way around that, and cursors have historically carried tokens and
 *    whole result payloads.
 *  - `config` — free-form jsonb. No SHIPPED connector routes a credential into
 *    feed-scoped config today, so this arm is hardening rather than a live
 *    leak — pinned so it stays that way.
 *
 * All three read actions are in the same exposure tier as the connection
 * list/get paths, so all three are asserted.
 */
describe("feed config redaction", () => {
	let workspace: TestWorkspace;
	let feedId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		workspace = await TestWorkspace.create({
			name: "Feed Redaction Org",
			visibility: "public",
		});

		const connection = await createTestConnection({
			organization_id: workspace.org.id,
			connector_key: "postgres",
			display_name: "Feedful Postgres",
			created_by: workspace.users.owner.id,
			visibility: "org",
		});

		// createTestConnection makes a 'default' feed; plant the probes plus a
		// checkpoint into it.
		const rows = await getTestDb()`
      UPDATE feeds
      SET config = ${getTestDb().json({ ...SECRET_PROBES, host: "db.internal" })}::jsonb,
          checkpoint = ${getTestDb().json({ cursor: "pw-LEAK-checkpoint" })}::jsonb
      WHERE connection_id = ${Number(connection.id)}
      RETURNING id
    `;
		feedId = Number((rows[0] as { id: number }).id);
	});

	it("does not leak feed secrets or checkpoint through feeds.list()", async () => {
		const result = await workspace.owner.feeds.list({});
		assertNoSecrets(result, "feeds.list()");
		expect(JSON.stringify(result)).not.toContain("pw-LEAK-checkpoint");
		expect(JSON.stringify(result)).not.toContain("checkpoint");
	});

	it("does not leak feed secrets or checkpoint through feeds.get()", async () => {
		const result = await workspace.owner.feeds.get({ feed_id: feedId });
		assertNoSecrets(result, "feeds.get()");
		expect(JSON.stringify(result)).not.toContain("pw-LEAK-checkpoint");

		// Redaction, not suppression — non-secret config survives.
		const feed = (result as { feed?: { config?: Record<string, unknown> } })
			.feed;
		expect(feed?.config?.host).toBe("db.internal");
	});

	it("does not leak feed secrets or checkpoint through feeds.readMany()", async () => {
		const result = await workspace.owner.feeds.readMany({ feed_ids: [feedId] });
		assertNoSecrets(result, "feeds.readMany()");
		expect(JSON.stringify(result)).not.toContain("pw-LEAK-checkpoint");
	});

	it("preserves the stored feed secret when a redacted config is PATCHed back", async () => {
		const read = (await workspace.owner.feeds.get({ feed_id: feedId })) as {
			feed?: { config?: Record<string, unknown> };
		};
		const fetched = read.feed?.config ?? {};
		expect(JSON.stringify(fetched)).toContain(REDACTED_SENTINEL);

		await workspace.owner.feeds.update({
			feed_id: feedId,
			config: { ...fetched, host: "db.updated" },
		});

		const rows = await getTestDb()`
      SELECT config FROM feeds WHERE id = ${feedId}
    `;
		const stored = (rows[0] as { config: Record<string, unknown> }).config;
		expect(stored.host).toBe("db.updated");
		expect(stored.password).toBe(SECRET_PROBES.password);
		expect(stored.DATABASE_URL).toBe(SECRET_PROBES.DATABASE_URL);
	});
});

/**
 * Redaction must not DESTROY the value it hides.
 *
 * Every real client round-trips config: the Owletto action-modes editor
 * (connection-settings-tab.tsx) spreads the FETCHED connection.config and
 * PATCHes it straight back with one field changed, and an agent calling
 * `connections.update` via run_sdk does the same. Once the read path returns
 * `__LOBU_REDACTED__` in place of a secret, that write path would persist the
 * SENTINEL over the real credential — the connection breaks at next use, with
 * no error at save time and no way to recover the plaintext.
 *
 * That failure mode is strictly worse than the leak it came from, so the write
 * path treats the sentinel as "unchanged" and restores the stored value.
 *
 * These assertions read the RAW `connections.config` jsonb straight from
 * Postgres on purpose. Asserting on the API response would be worthless here —
 * the response is redacted either way, so a corrupted row and a healthy row are
 * indistinguishable through it, and the test would pass while the credential
 * was already destroyed.
 */
describe("connection config redaction > sentinel round-trip", () => {
	let workspace: TestWorkspace;
	let connectionId: number;

	/** The stored plaintext, straight from the row. */
	async function storedConfig(): Promise<Record<string, unknown>> {
		const rows = await getTestDb()`
      SELECT config FROM connections WHERE id = ${connectionId}
    `;
		return (rows[0] as { config: Record<string, unknown> }).config;
	}

	beforeAll(async () => {
		await cleanupTestDatabase();
		workspace = await TestWorkspace.create({
			name: "Round Trip Org",
			visibility: "public",
		});

		connectionId = Number(
			(
				await createTestConnection({
					organization_id: workspace.org.id,
					connector_key: "postgres",
					display_name: "Round Trip Postgres",
					created_by: workspace.users.owner.id,
					visibility: "org",
					config: { ...SECRET_PROBES, host: "db.internal" },
				})
			).id,
		);
	});

	it("preserves the stored secret when a redacted config is PATCHed back", async () => {
		// Exactly what the UI does: read, spread, change one unrelated field.
		const read = (await workspace.owner.connections.get(connectionId)) as {
			connection?: { config?: Record<string, unknown> };
		};
		const fetched = read.connection?.config ?? {};
		// Precondition: the read really is redacted, otherwise this test would
		// pass for the wrong reason (nothing to round-trip).
		expect(JSON.stringify(fetched)).toContain(REDACTED_SENTINEL);

		await workspace.owner.connections.update({
			connection_id: connectionId,
			config: { ...fetched, action_modes: { some_op: "auto" } },
		});

		const stored = await storedConfig();
		// The unrelated edit landed...
		expect(stored.action_modes).toEqual({ some_op: "auto" });
		// ...and every secret survived, at every depth and shape.
		expect(stored.password).toBe(SECRET_PROBES.password);
		expect(stored.api_key).toBe(SECRET_PROBES.api_key);
		expect(stored.refresh_token).toBe(SECRET_PROBES.refresh_token);
		expect(stored.cookie).toBe(SECRET_PROBES.cookie);
		// The URI form: redactUriCredentials emits
		// `postgres://__LOBU_REDACTED__@host/db`, which is NOT equal to the bare
		// sentinel — a naive equality check would miss it and clobber the DSN.
		expect(stored.DATABASE_URL).toBe(SECRET_PROBES.DATABASE_URL);
		// Nested, including below the SQL redaction depth bound.
		const nested = stored.nested as Record<string, Record<string, unknown>>;
		expect(nested.database.password).toBe("pw-LEAK-nested-password");
		expect((nested.headers as Record<string, unknown>).Authorization).toBe(
			"Bearer pw-LEAK-bearer",
		);
		expect((nested.credentials as Record<string, unknown>).client_secret).toBe(
			"pw-LEAK-client-secret",
		);
		// Non-secret values still update normally.
		expect(stored.host).toBe("db.internal");
	});

	it("still lets a caller set a genuinely new secret", async () => {
		// Preserve-on-sentinel must not become "secrets are immutable": a real
		// rotation has to go through.
		await workspace.owner.connections.update({
			connection_id: connectionId,
			config: { password: "rotated-plaintext" },
		});
		expect((await storedConfig()).password).toBe("rotated-plaintext");
	});

	it("preserves secrets under replace_config (declarative apply)", async () => {
		// `lobu apply` sends replace_config: true so a REMOVED manifest key really
		// disappears. A sentinel there still means "unchanged", not "set the
		// literal sentinel" — otherwise re-applying a manifest built from a
		// redacted read would wipe every credential in the org at once.
		const read = (await workspace.owner.connections.get(connectionId)) as {
			connection?: { config?: Record<string, unknown> };
		};
		const fetched = read.connection?.config ?? {};

		await workspace.owner.connections.update({
			connection_id: connectionId,
			config: { ...fetched, host: "db.replaced" },
			replace_config: true,
		});

		const stored = await storedConfig();
		expect(stored.host).toBe("db.replaced");
		expect(stored.password).toBe("rotated-plaintext");
		expect(stored.DATABASE_URL).toBe(SECRET_PROBES.DATABASE_URL);
	});
});
