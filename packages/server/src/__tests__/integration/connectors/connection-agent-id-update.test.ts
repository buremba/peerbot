/**
 * manage_connections `update` — chat fallback agent (`agent_id`).
 *
 * An OAuth-installed chat connection has no full config to re-apply, so
 * `apply_chat_connection` (which requires credentials) cannot reassign its
 * fallback agent — `update` must. These tests drive the real handler through
 * the sandbox namespace (so `withValidatedArgs` runs) against `lobu_test`,
 * with a real ChatInstanceManager wired to the Postgres connection store via
 * the gateway test seam, proving:
 *   1. `update` with agent_id persists connections.agent_id (the runtime
 *      fallback; channel bindings remain authoritative) and audits the change
 *      with `agent_id` in changed_fields;
 *   2. `agent_id: null` clears the fallback;
 *   3. an agent_id outside the org rejects ("Agent not found") without
 *      touching the row;
 *   4. `update` with agent_id on a NON-chat connection rejects — nothing
 *      reads that column for data connectors;
 *   5. the unknown-arg chokepoint rejects agent_id on an action that lacks it
 *      (`get`) instead of silently dropping it — the original bug shape.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import { ChatInstanceManager } from "../../../gateway/connections/chat-instance-manager";
import type { PlatformConnection } from "../../../gateway/connections/types";
import { SecretStoreRegistry } from "../../../gateway/secrets/index";
import { __setChatInstanceManagerForTests } from "../../../lobu/gateway";
import { orgContext } from "../../../lobu/stores/org-context";
import { createPostgresAppInstallationStore } from "../../../lobu/stores/app-installation-store";
import { PostgresSecretStore } from "../../../lobu/stores/postgres-secret-store";
import { createPostgresAgentConnectionStore } from "../../../lobu/stores/postgres-stores";
import { upsertSlackInstallByTeam } from "../../../lobu/stores/slack-installations";
import {
	createTestAgent,
	createTestConnection,
} from "../../setup/test-fixtures";
import { TestWorkspace } from "../../setup/test-mcp-client";

const ENCRYPTION_KEY =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const RUNTIME_ID = "agentfb-slack-1";
const SLUG = `agentconn-${RUNTIME_ID}`;

async function agentIdOf(connectionId: number): Promise<string | null> {
	const rows = (await getDb()`
		SELECT agent_id FROM connections WHERE id = ${connectionId}
	`) as Array<{ agent_id: string | null }>;
	return rows[0]?.agent_id ?? null;
}

async function connRow(
	connectionId: number,
): Promise<{ credential_mode: string | null; config: Record<string, unknown> }> {
	const rows = (await getDb()`
		SELECT credential_mode, config FROM connections WHERE id = ${connectionId}
	`) as Array<{ credential_mode: string | null; config: Record<string, unknown> }>;
	return rows[0];
}

/** The audit write is fire-and-forget (retryWithBackoff), so poll for it. */
async function waitForAuditEvent(
	orgId: string,
	connectionId: number,
): Promise<Record<string, unknown> | null> {
	for (let i = 0; i < 50; i += 1) {
		const rows = (await getDb()`
			SELECT metadata FROM events
			WHERE organization_id = ${orgId}
			  AND origin_type = 'config_connection_updated'
			  AND metadata->>'resource_id' = ${String(connectionId)}
			ORDER BY id DESC
			LIMIT 1
		`) as Array<{ metadata: Record<string, unknown> }>;
		if (rows.length > 0) return rows[0].metadata;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return null;
}

describe("manage_connections update — chat fallback agent_id", () => {
	let workspace: TestWorkspace;
	let orgId: string;
	let agentA: string;
	let agentB: string;
	let chatConnectionId: number;
	let dataConnectionId: number;
	let managedConnectionId: number;
	let manager: ChatInstanceManager;

	beforeAll(async () => {
		process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
		workspace = await TestWorkspace.create({ name: "Agent Fallback Org" });
		orgId = workspace.org.id;
		agentA = (await createTestAgent({ organizationId: orgId })).agentId;
		agentB = (await createTestAgent({ organizationId: orgId })).agentId;

		// Real manager + real Postgres store, injected via the test seam — the
		// full persistence chain (manager → store → connections projection) runs.
		const store = createPostgresAgentConnectionStore();
		manager = new ChatInstanceManager();
		(manager as unknown as { connectionStore: unknown }).connectionStore =
			store;
		const pss = new PostgresSecretStore();
		(manager as unknown as { services: unknown }).services = {
			getSecretStore: () => new SecretStoreRegistry(pss, { secret: pss }),
		};
		__setChatInstanceManagerForTests(manager);

		// A BYO chat connection whose fallback agent starts as agentA.
		await orgContext.run({ organizationId: orgId }, () =>
			store.saveConnection({
				id: RUNTIME_ID,
				platform: "slack",
				agentId: agentA,
				organizationId: orgId,
				config: { platform: "slack", botToken: "secret://agentfb-1" },
				settings: { allowGroups: true },
				metadata: { teamId: "TAFB1", teamName: "Agent FB" },
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const rows = (await getDb()`
			SELECT id FROM connections
			WHERE organization_id = ${orgId} AND slug = ${SLUG}
		`) as Array<{ id: number }>;
		chatConnectionId = Number(rows[0].id);

		// A non-chat (data) connection for the rejection path.
		dataConnectionId = Number(
			(
				await createTestConnection({
					organization_id: orgId,
					connector_key: "github",
					display_name: "Data GitHub",
					created_by: workspace.users.owner.id,
				})
			).id,
		);

		// A MANAGED (OAuth-installed) Slack connection — credential_mode='managed'.
		// This is the real target of the feature: you can't apply_chat_connection
		// on it (no full config), so `update` must set its fallback agent WITHOUT
		// reclassifying it to BYO.
		const pss2 = new PostgresSecretStore();
		const managedSecretStore = new SecretStoreRegistry(pss2, { secret: pss2 });
		const installStore = createPostgresAppInstallationStore();
		const installRow = await upsertSlackInstallByTeam(
			installStore,
			managedSecretStore,
			orgId,
			"TMANAGED1",
			{ teamName: "Managed Co", botUserId: "U-MGD", botToken: "xoxb-managed" },
		);
		const managedRows = (await getDb()`
			SELECT id FROM connections
			WHERE organization_id = ${orgId} AND slug = ${installRow.id}
		`) as Array<{ id: number }>;
		managedConnectionId = Number(managedRows[0].id);
	}, 60_000);

	afterAll(async () => {
		__setChatInstanceManagerForTests(null);
		const sql = getDb();
		await sql`DELETE FROM connections WHERE organization_id = ${orgId}`;
	});

	it("sets the fallback agent on a chat connection and audits it", async () => {
		expect(await agentIdOf(chatConnectionId)).toBe(agentA);

		const result = (await workspace.owner.connections.update({
			connection_id: chatConnectionId,
			agent_id: agentB,
		})) as { action?: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.action).toBe("update");

		expect(await agentIdOf(chatConnectionId)).toBe(agentB);

		const audit = await waitForAuditEvent(orgId, chatConnectionId);
		expect(audit).not.toBeNull();
		expect(audit?.changed_fields).toContain("agent_id");
	});

	it("agent_id: null clears the fallback", async () => {
		const result = (await workspace.owner.connections.update({
			connection_id: chatConnectionId,
			agent_id: null,
		})) as { error?: string };
		expect(result.error).toBeUndefined();
		expect(await agentIdOf(chatConnectionId)).toBeNull();
	});

	it("rejects an agent_id that does not exist in the org, leaving the row untouched", async () => {
		const before = await agentIdOf(chatConnectionId);
		const result = (await workspace.owner.connections.update({
			connection_id: chatConnectionId,
			agent_id: "agent-does-not-exist",
		})) as { error?: string };
		expect(result.error).toBe("Agent not found");
		expect(await agentIdOf(chatConnectionId)).toBe(before);
	});

	it("rejects agent_id on a non-chat connection", async () => {
		const result = (await workspace.owner.connections.update({
			connection_id: dataConnectionId,
			agent_id: agentB,
		})) as { error?: string };
		expect(result.error).toMatch(/applies only to chat connections/);
		expect(await agentIdOf(dataConnectionId)).toBeNull();
	});

	it("rejects agent_id on an action that lacks it instead of silently dropping it", async () => {
		await expect(
			workspace.owner.connections.manage({
				action: "get",
				connection_id: chatConnectionId,
				agent_id: agentB,
			}),
		).rejects.toThrow(/unknown argument\(s\): agent_id/);
	});

	it("denies a member (non-admin) who owns the connection but is not an admin from setting agent_id", async () => {
		// A chat connection OWNED BY THE MEMBER. `update` is member-writable and
		// the member owns this row, so they pass the ownership gate — but
		// reassigning the fallback agent is channel-binding-tier authority, so
		// it must still be refused. Otherwise the member could point their
		// connection's fallback at another member's agent (an escalation
		// bind_channel forbids).
		const memberRuntimeId = "agentfb-member-1";
		await orgContext.run({ organizationId: orgId }, () =>
			(
				manager as unknown as { connectionStore: { saveConnection: (c: unknown) => Promise<void> } }
			).connectionStore.saveConnection({
				id: memberRuntimeId,
				platform: "slack",
				agentId: agentA,
				organizationId: orgId,
				config: { platform: "slack", botToken: "secret://member-1" },
				settings: { allowGroups: true },
				metadata: { teamId: "TMEMBER1", teamName: "Member FB" },
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const rows = (await getDb()`
			SELECT id FROM connections
			WHERE organization_id = ${orgId} AND slug = ${`agentconn-${memberRuntimeId}`}
		`) as Array<{ id: number }>;
		const memberConnId = Number(rows[0].id);
		await getDb()`
			UPDATE connections SET created_by = ${workspace.users.member.id}
			WHERE id = ${memberConnId}
		`;

		const before = await agentIdOf(memberConnId);
		const result = (await workspace.member.connections.update({
			connection_id: memberConnId,
			agent_id: agentB,
		})) as { error?: string };
		expect(result.error).toMatch(/Only admins can set/);
		// Row untouched — the escalation was blocked before any write.
		expect(await agentIdOf(memberConnId)).toBe(before);
	});

	it("a warm instance routes to the NEW agent after an agentId-only update (shared reference mutated in place)", async () => {
		// The message-handler bridge captures the instance's `connection` object
		// at start time and reads `connection.agentId` per inbound message. Seed
		// a warm instance whose connection object we hold a reference to — the
		// same reference the bridge would hold — then run an agentId-only update
		// and assert THAT object now carries the new agent. If updateConnection
		// replaced the reference instead of mutating in place, the captured
		// object (and thus the live bridge) would keep routing to the old agent.
		const instances = (
			manager as unknown as { instances: Map<string, { connection: PlatformConnection; rowVersion: number }> }
		).instances;

		// Reset the fallback to agentA, then register the warm instance holding
		// the current runtime connection (as the bridge would).
		await workspace.owner.connections.update({
			connection_id: chatConnectionId,
			agent_id: agentA,
		});
		const warmConnection = (await manager.getConnection(
			RUNTIME_ID,
		)) as PlatformConnection;
		expect(warmConnection.agentId).toBe(agentA);
		// A warm instance holds PLAINTEXT credentials resolved at startup — the
		// store row holds `secret://` refs. Stamp a plaintext token to prove the
		// update path leaves the warm config alone (no secret:// clobber).
		(warmConnection.config as Record<string, unknown>).botToken =
			"xoxb-plaintext-live-token";
		const configRef = warmConnection.config;
		instances.set(RUNTIME_ID, {
			connection: warmConnection,
			rowVersion: warmConnection.updatedAt,
		});

		try {
			await workspace.owner.connections.update({
				connection_id: chatConnectionId,
				agent_id: agentB,
			});
			// Same object reference the bridge holds now sees the new agent.
			expect(warmConnection.agentId).toBe(agentB);
			expect(instances.get(RUNTIME_ID)?.connection).toBe(warmConnection);
			// Config untouched — still the plaintext token, not a secret:// ref.
			// (A blanket Object.assign from storage would have overwritten it.)
			expect(warmConnection.config).toBe(configRef);
			expect(
				(warmConnection.config as Record<string, unknown>).botToken,
			).toBe("xoxb-plaintext-live-token");

			// Clearing to null must also propagate to the captured reference.
			await workspace.owner.connections.update({
				connection_id: chatConnectionId,
				agent_id: null,
			});
			expect(warmConnection.agentId).toBeUndefined();
			expect(
				(warmConnection.config as Record<string, unknown>).botToken,
			).toBe("xoxb-plaintext-live-token");
		} finally {
			instances.delete(RUNTIME_ID);
		}
	});

	it("sets agent_id on a MANAGED connection without reclassifying it to BYO", async () => {
		const before = await connRow(managedConnectionId);
		expect(before.credential_mode).toBe("managed");

		const result = (await workspace.owner.connections.update({
			connection_id: managedConnectionId,
			agent_id: agentB,
		})) as { action?: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.action).toBe("update");

		expect(await agentIdOf(managedConnectionId)).toBe(agentB);
		// The whole point: still MANAGED. A store-forced "byo" here would later
		// skip revokeManagedConnection on delete (leaking install creds).
		const after = await connRow(managedConnectionId);
		expect(after.credential_mode).toBe("managed");
	});

	it("rejects an empty-string agent_id instead of destructively clearing", async () => {
		// Seed a known fallback, then attempt an empty-string update. "" is a
		// falsy string Type.String() permits; without an explicit guard it would
		// skip the existence check and clear the fallback. Contract: only null
		// clears.
		await workspace.owner.connections.update({
			connection_id: chatConnectionId,
			agent_id: agentA,
		});
		expect(await agentIdOf(chatConnectionId)).toBe(agentA);

		const result = (await workspace.owner.connections.update({
			connection_id: chatConnectionId,
			agent_id: "",
		})) as { error?: string };
		expect(result.error).toMatch(/non-empty/);
		// Fallback untouched — not cleared.
		expect(await agentIdOf(chatConnectionId)).toBe(agentA);
	});

	// The credential_mode-preserve read must be scoped to the LIVE row. Slug
	// uniqueness holds only for live rows, so a same-slug TOMBSTONE of the
	// OPPOSITE mode must never be the row whose credential_mode gets preserved
	// — otherwise an agent_id update reclassifies the live connection.
	describe("same-slug opposite-mode tombstone does not reclassify the live row", () => {
		// Seed a deleted row + a live row sharing one slug, then set agent_id on
		// the live connection and return its credential_mode afterward.
		async function seedPairAndUpdate(
			slug: string,
			tombstoneMode: "managed" | "byo",
			liveMode: "managed" | "byo",
		): Promise<string | null> {
			const sql = getDb();
			// Tombstone: same slug, opposite mode, soft-deleted.
			await sql`
				INSERT INTO connections (
					organization_id, connector_key, external_tenant_id, agent_id,
					display_name, status, config, credential_mode, slug, visibility,
					deleted_at, created_at, updated_at
				) VALUES (
					${orgId}, 'slack', ${`tenant-tomb-${slug}`}, ${agentA},
					'Tombstone', 'active', ${sql.json({ platform: "slack" })},
					${tombstoneMode}, ${slug}, 'org', now(), now(), now()
				)
			`;
			// Live row: same slug, the mode we must preserve.
			const liveRows = (await sql`
				INSERT INTO connections (
					organization_id, connector_key, external_tenant_id, agent_id,
					display_name, status, config, credential_mode, slug, visibility,
					created_at, updated_at
				) VALUES (
					${orgId}, 'slack', ${`tenant-live-${slug}`}, ${agentA},
					'Live', 'active', ${sql.json({ platform: "slack", botToken: "secret://live" })},
					${liveMode}, ${slug}, 'org', now(), now()
				)
				RETURNING id
			`) as Array<{ id: number }>;
			const liveId = Number(liveRows[0].id);

			const result = (await workspace.owner.connections.update({
				connection_id: liveId,
				agent_id: agentB,
			})) as { error?: string };
			expect(result.error).toBeUndefined();
			expect(await agentIdOf(liveId)).toBe(agentB);
			return (await connRow(liveId)).credential_mode;
		}

		it("live BYO + managed tombstone stays BYO", async () => {
			const mode = await seedPairAndUpdate(
				"agentconn-tomb-byo-live",
				"managed",
				"byo",
			);
			expect(mode).toBe("byo");
		});

		it("live managed + byo tombstone stays managed (else finding #1 reopens)", async () => {
			const mode = await seedPairAndUpdate(
				"slackinst-tomb-managed-live",
				"byo",
				"managed",
			);
			expect(mode).toBe("managed");
		});
	});
});
