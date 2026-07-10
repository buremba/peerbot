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
	let connStore: ReturnType<typeof createPostgresAgentConnectionStore>;
	let installStore: ReturnType<typeof createPostgresAppInstallationStore>;
	let managedSecretStore: SecretStoreRegistry;

	beforeAll(async () => {
		process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
		workspace = await TestWorkspace.create({ name: "Agent Fallback Org" });
		orgId = workspace.org.id;
		agentA = (await createTestAgent({ organizationId: orgId })).agentId;
		agentB = (await createTestAgent({ organizationId: orgId })).agentId;

		// Real manager + real Postgres store, injected via the test seam — the
		// full persistence chain (manager → store → connections projection) runs.
		connStore = createPostgresAgentConnectionStore();
		manager = new ChatInstanceManager();
		(manager as unknown as { connectionStore: unknown }).connectionStore =
			connStore;
		const pss = new PostgresSecretStore();
		(manager as unknown as { services: unknown }).services = {
			getSecretStore: () => new SecretStoreRegistry(pss, { secret: pss }),
		};
		__setChatInstanceManagerForTests(manager);

		// A BYO chat connection whose fallback agent starts as agentA.
		await orgContext.run({ organizationId: orgId }, () =>
			connStore.saveConnection({
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
		managedSecretStore = new SecretStoreRegistry(pss2, { secret: pss2 });
		installStore = createPostgresAppInstallationStore();
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

	it("a managed reinstall preserves the configured fallback agent_id; explicit null still clears", async () => {
		// Configure the fallback via the real update path — the exact scenario
		// PR1 exists for.
		const set = (await workspace.owner.connections.update({
			connection_id: managedConnectionId,
			agent_id: agentA,
		})) as { error?: string };
		expect(set.error).toBeUndefined();
		expect(await agentIdOf(managedConnectionId)).toBe(agentA);

		// The workspace reinstalls (same team, fresh token). A reinstall carries
		// NO agent-routing intent, so it must not touch the fallback.
		await upsertSlackInstallByTeam(
			installStore,
			managedSecretStore,
			orgId,
			"TMANAGED1",
			{
				teamName: "Managed Co",
				botUserId: "U-MGD",
				botToken: "xoxb-managed-reinstalled",
			},
		);
		expect(await agentIdOf(managedConnectionId)).toBe(agentA);
		// Still the same live row, still managed.
		expect((await connRow(managedConnectionId)).credential_mode).toBe(
			"managed",
		);

		// An EXPLICIT clear (agent_id: null) must still null the column — the
		// preserve applies only to writes that carry no agent_id intent.
		const clear = (await workspace.owner.connections.update({
			connection_id: managedConnectionId,
			agent_id: null,
		})) as { error?: string };
		expect(clear.error).toBeUndefined();
		expect(await agentIdOf(managedConnectionId)).toBeNull();

		// …and a reinstall on an intentionally-cleared fallback keeps it cleared
		// (preserve must not resurrect a value from nowhere).
		await upsertSlackInstallByTeam(
			installStore,
			managedSecretStore,
			orgId,
			"TMANAGED1",
			{
				teamName: "Managed Co",
				botUserId: "U-MGD",
				botToken: "xoxb-managed-reinstalled-2",
			},
		);
		expect(await agentIdOf(managedConnectionId)).toBeNull();
	});

	it("saveConnection takes the tenant advisory lock BEFORE the row lock (no deadlock against a managed reinstall)", async () => {
		// Lock-order contract: every chat-connection write path acquires the
		// tenant ADVISORY lock first, THEN connections row locks. The managed
		// reinstall path (upsertChatConnectionProjection) is advisory → row;
		// if saveConnection row-locked first (FOR UPDATE) and only then reached
		// the projection's advisory lock, a concurrent update + reinstall would
		// deadlock. This test holds the advisory lock the way a reinstall does,
		// runs the REAL saveConnection until it blocks on that lock, then takes
		// the row lock the reinstall would take next: with the inverted order
		// saveConnection already holds the row ⇒ Postgres aborts one txn with
		// "deadlock detected"; with the fixed order it holds nothing ⇒ clean.
		const sql = getDb();
		const runtimeId = "agentfb-lockorder-1";
		const lockSlug = `agentconn-${runtimeId}`;
		const teamId = "TLOCK1";
		const seed = (agentId: string) => ({
			id: runtimeId,
			platform: "slack",
			agentId,
			organizationId: orgId,
			config: { platform: "slack", botToken: "secret://lockorder-1" },
			settings: { allowGroups: true },
			metadata: { teamId, teamName: "Lock Order" },
			status: "active" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		await orgContext.run({ organizationId: orgId }, () =>
			connStore.saveConnection(seed(agentA)),
		);

		// Same key derivation as chatTenantAdvisoryLockKey / the projection.
		const lockKey = `chatconn:${orgId}:slack:${teamId}`;
		// int8 advisory locks surface in pg_locks as classid = high 32 bits,
		// objid = low 32 bits of the (sign-extended) hashtext key.
		const waitingOnAdvisory = async (): Promise<boolean> => {
			const rows = (await sql`
				WITH k AS (SELECT hashtext(${lockKey})::bigint AS key)
				SELECT 1 FROM pg_locks, k
				WHERE locktype = 'advisory' AND NOT granted
				  AND classid::bigint = ((k.key >> 32) & 4294967295)
				  AND objid::bigint = (k.key & 4294967295)
			`) as unknown[];
			return rows.length > 0;
		};

		let advisoryHeld!: () => void;
		const advisoryHeldGate = new Promise<void>((resolve) => {
			advisoryHeld = resolve;
		});
		let reinstallProceed!: () => void;
		const reinstallGate = new Promise<void>((resolve) => {
			reinstallProceed = resolve;
		});

		// T2 — the reinstall's exact lock sequence: advisory tenant lock, then
		// the connections row.
		const reinstallTxn = sql.begin(async (tx: typeof sql) => {
			await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [
				lockKey,
			]);
			advisoryHeld();
			await reinstallGate;
			await tx`
				UPDATE connections SET updated_at = now()
				WHERE organization_id = ${orgId} AND slug = ${lockSlug}
				  AND deleted_at IS NULL
			`;
		});
		await advisoryHeldGate;

		// T1 — the REAL fallback-agent update write path.
		const updateTxn = orgContext.run({ organizationId: orgId }, () =>
			connStore.saveConnection(seed(agentB)),
		);

		// Wait until T1 is provably blocked on the advisory lock T2 holds.
		for (let i = 0; i < 200 && !(await waitingOnAdvisory()); i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(await waitingOnAdvisory()).toBe(true);

		// Now T2 takes its row lock. Inverted order ⇒ deadlock detected here.
		reinstallProceed();
		await reinstallTxn;
		await updateTxn;

		const rows = (await sql`
			SELECT agent_id FROM connections
			WHERE organization_id = ${orgId} AND slug = ${lockSlug}
		`) as Array<{ agent_id: string | null }>;
		expect(rows[0]?.agent_id).toBe(agentB);
	}, 30_000);

	it("a MANAGED saveConnection takes the managed-global advisory lock BEFORE its row lock (no cross-org transfer deadlock)", async () => {
		// A MANAGED write takes TWO advisory locks in the projection: the
		// org-specific tenant lock, THEN the GLOBAL managed-workspace lock, which
		// then row-locks OTHER orgs' rows to demote a transferred install. A
		// concurrent cross-org transfer takes chatconn:managed:slack:T then tries
		// to demote THIS org's managed row. If saveConnection row-locked first
		// (FOR UPDATE) and only reached chatconn:managed AFTER, the two invert:
		// transfer holds managed-global + waits on our row; we hold our row +
		// wait on managed-global ⇒ 40P01. Post-fix saveConnection pre-acquires
		// chatconn:managed BEFORE its row lock, so it simply queues behind the
		// transfer's managed-global lock — no cycle.
		//
		// Reproduce: a manual holder txn takes chatconn:managed:slack:T (the
		// transfer's position after ITS own org-specific lock), then runs the
		// REAL saveConnection on THIS org's managed row until pg_locks shows it
		// blocked on chatconn:managed, then the holder row-locks this org's row.
		// Inverted order ⇒ deadlock here; fixed order ⇒ clean.
		const sql = getDb();
		const teamId = "TXFER1";
		const runtimeId = "slackinst-xfer-1"; // managed slug passes through verbatim
		const seed = (agentId: string) => ({
			id: runtimeId,
			platform: "slack",
			agentId,
			organizationId: orgId,
			config: { platform: "slack", botToken: "secret://xfer-1" },
			settings: { allowGroups: true },
			metadata: { teamId, teamName: "Transfer Co" },
			status: "active" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		// Seed as MANAGED. saveConnection now pre-acquires the managed-global lock
		// for EVERY active tenant-bound write (mode-independent), so both a
		// managed and a BYO row would take it — this case keeps the managed
		// variant; the BYO variant is covered by the lock-presence test below.
		await sql`
			INSERT INTO connections (
				organization_id, connector_key, external_tenant_id, agent_id,
				display_name, status, config, credential_mode, slug, visibility,
				created_at, updated_at
			) VALUES (
				${orgId}, 'slack', ${teamId}, ${agentA},
				'Transfer Co', 'active', ${sql.json({ platform: "slack", botToken: "secret://xfer-1" })},
				'managed', ${runtimeId}, 'org', now(), now()
			)
		`;

		const managedKey = `chatconn:managed:slack:${teamId}`;
		const waitingOnManaged = async (): Promise<boolean> => {
			const r = (await sql`
				WITH k AS (SELECT hashtext(${managedKey})::bigint AS key)
				SELECT 1 FROM pg_locks, k
				WHERE locktype = 'advisory' AND NOT granted
				  AND classid::bigint = ((k.key >> 32) & 4294967295)
				  AND objid::bigint = (k.key & 4294967295)
			`) as unknown[];
			return r.length > 0;
		};

		let managedHeld!: () => void;
		const managedHeldGate = new Promise<void>((resolve) => {
			managedHeld = resolve;
		});
		let transferProceed!: () => void;
		const transferGate = new Promise<void>((resolve) => {
			transferProceed = resolve;
		});

		// T2 — the transfer's managed-lock-then-demote sequence.
		const transferTxn = sql.begin(async (tx: typeof sql) => {
			await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [
				managedKey,
			]);
			managedHeld();
			await transferGate;
			// Demote THIS org's managed row (what the projection's transfer branch
			// does to any other-org managed row for the team) — the row lock.
			await tx`
				UPDATE connections SET status = 'paused', updated_at = now()
				WHERE organization_id = ${orgId} AND slug = ${runtimeId}
				  AND deleted_at IS NULL
			`;
		});
		await managedHeldGate;

		// T1 — the REAL managed write path.
		const saveTxn = orgContext.run({ organizationId: orgId }, () =>
			connStore.saveConnection(seed(agentB)),
		);

		for (let i = 0; i < 200 && !(await waitingOnManaged()); i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		// Post-fix: T1 pre-acquires chatconn:managed before its row lock ⇒ it is
		// provably parked on the managed-global lock, holding no row. Pre-fix it
		// would instead already hold the row and be waiting on managed-global,
		// and the reinstallProceed step below would 40P01.
		expect(await waitingOnManaged()).toBe(true);

		transferProceed();
		await transferTxn;
		await saveTxn;

		const rows = (await sql`
			SELECT agent_id, credential_mode FROM connections
			WHERE organization_id = ${orgId} AND slug = ${runtimeId}
		`) as Array<{ agent_id: string | null; credential_mode: string | null }>;
		expect(rows[0]?.agent_id).toBe(agentB);
		// Still managed — the write preserved credential_mode.
		expect(rows[0]?.credential_mode).toBe("managed");
	}, 30_000);

	it("a BYO tenant-bound saveConnection acquires chatconn:managed BEFORE it row-locks the target (mode-independent pre-acquire closes the peek TOCTOU)", async () => {
		// The managed-global lock must be taken by EVERY active tenant-bound write
		// regardless of credential_mode. A lock-free peek at the mode was a
		// TOCTOU: a concurrent managed install could flip a byo/empty row to
		// managed between the peek and the FOR UPDATE; the projection (now
		// managed) then takes chatconn:managed while this txn already holds the
		// target row ⇒ the cross-org cycle reopens.
		//
		// The distinguishing property is ORDER: post-fix a BYO write takes
		// chatconn:managed BEFORE it row-locks the target; pre-fix (byo peek) it
		// row-locks the target first and only reaches chatconn:managed inside the
		// projection. Isolate that: hold the TARGET ROW lock in a manual txn and
		// run the REAL BYO saveConnection. Post-fix it parks on the ROW while
		// already HOLDING chatconn:managed ⇒ a probe txn canNOT acquire
		// chatconn:managed (a conditional pg_try_advisory_xact_lock fails).
		// Pre-fix it parks on the ROW WITHOUT holding chatconn:managed ⇒ the
		// probe WOULD succeed. This asserts the managed lock is held while the
		// BYO write waits on the row — the exact ordering guarantee, isolated
		// from the projection's own (later) acquire.
		const sql = getDb();
		const teamId = "TBYOLOCK1";
		const runtimeId = "agentfb-byolock-1";
		const byoSlug = `agentconn-${runtimeId}`;
		const managedKey = `chatconn:managed:slack:${teamId}`;

		// Seed the row so the manual holder can row-lock it (and so the BYO
		// saveConnection updates rather than inserts — an INSERT takes no
		// pre-existing row lock to contend on).
		await sql`
			INSERT INTO connections (
				organization_id, connector_key, external_tenant_id, agent_id,
				display_name, status, config, credential_mode, slug, visibility,
				created_at, updated_at
			) VALUES (
				${orgId}, 'slack', ${teamId}, ${agentA},
				'BYO Lock', 'active', ${sql.json({ platform: "slack", botToken: "secret://byolock-1" })},
				'byo', ${byoSlug}, 'org', now(), now()
			)
		`;

		let rowHeldGate!: () => void;
		const rowHeld = new Promise<void>((resolve) => {
			rowHeldGate = resolve;
		});
		let releaseRow!: () => void;
		const release = new Promise<void>((resolve) => {
			releaseRow = resolve;
		});
		// Holder txn: lock the TARGET ROW, signal, then wait.
		const holderTxn = sql.begin(async (tx: typeof sql) => {
			await tx`
				SELECT id FROM connections
				WHERE organization_id = ${orgId} AND slug = ${byoSlug}
				  AND deleted_at IS NULL
				FOR UPDATE
			`;
			rowHeldGate();
			await release;
		});
		await rowHeld;

		// The REAL BYO write (existing byo row ⇒ credential_mode peeks/reads byo).
		const byoWrite = orgContext.run({ organizationId: orgId }, () =>
			connStore.saveConnection({
				id: runtimeId,
				platform: "slack",
				agentId: agentB,
				organizationId: orgId,
				config: { platform: "slack", botToken: "secret://byolock-1" },
				settings: { allowGroups: true },
				metadata: { teamId, teamName: "BYO Lock" },
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);

		// Wait until the BYO write is provably blocked on the target ROW the
		// holder owns (ShareLock on the tuple / the holder's xid).
		const blockedOnRow = async (): Promise<boolean> => {
			const r = (await sql`
				SELECT 1 FROM pg_locks
				WHERE locktype IN ('tuple', 'transactionid')
				  AND NOT granted
			`) as unknown[];
			return r.length > 0;
		};
		for (let i = 0; i < 200 && !(await blockedOnRow()); i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(await blockedOnRow()).toBe(true);

		// While the BYO write waits on the row, probe chatconn:managed with a
		// CONDITIONAL lock. Post-fix the BYO write already HOLDS it ⇒ probe fails
		// (false). Pre-fix (byo peek skipped it) ⇒ probe would succeed (true).
		const probe = (await sql`
			SELECT pg_try_advisory_xact_lock(hashtext(${managedKey})) AS got
		`) as Array<{ got: boolean }>;
		expect(probe[0]?.got).toBe(false);

		releaseRow();
		await holderTxn;
		await byoWrite;

		const rows = (await sql`
			SELECT credential_mode, agent_id FROM connections
			WHERE organization_id = ${orgId} AND slug = ${byoSlug}
		`) as Array<{ credential_mode: string | null; agent_id: string | null }>;
		expect(rows[0]?.credential_mode).toBe("byo");
		expect(rows[0]?.agent_id).toBe(agentB);
	}, 30_000);
});
