/**
 * MCP entitySchema.createType approval lifecycle.
 *
 * This is intentionally a wire-level test for proposal creation: the caller
 * enters through JSON-RPC tools/call -> run_sdk -> ClientSDK, which is the same
 * path MCP Inspector and ChatGPT use. Approval resolution enters through the
 * existing MCP App tools, proving the held proposal is applied only after a
 * human owner uses the capability-bound confirmation surface.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertEntityApprovalPolicy } from "../../../authz/entity-policy";
import { getDb } from "../../../db/client";
import { clearInMemoryMcpSessionsForTests } from "../../../mcp-handler";
import {
	addUserToOrganization,
	createTestAccessToken,
	createTestOAuthClient,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";
import { cleanupTestDatabase } from "../../setup/test-db";
import { mcpRequest, mcpToolsCall } from "../../setup/test-helpers";
import { TestApiClient } from "../../setup/test-mcp-client";

type PendingCreate = {
	schema_type: "entity_type";
	action: "create";
	status: "pending_approval";
	run_id: number;
	event_id: number;
	approval_url: string;
	proposal: {
		version: 1;
		resource_class: "entity_schema";
		policy_action: "create_type";
		schema_type: "entity_type";
		action: "create";
		args: Record<string, unknown>;
	};
	current: null;
};

describe("MCP entitySchema.createType approval", () => {
	let org: Awaited<ReturnType<typeof createTestOrganization>>;
	let owner: Awaited<ReturnType<typeof createTestUser>>;
	let member: Awaited<ReturnType<typeof createTestUser>>;
	let memberToken: string;
	let ownerWriteToken: string;
	let ownerAdminToken: string;

	beforeAll(async () => {
		await cleanupTestDatabase();
		clearInMemoryMcpSessionsForTests();

		org = await createTestOrganization({
			name: "Entity schema MCP approval",
			slug: "entity-schema-mcp-approval",
		});
		owner = await createTestUser({
			email: "entity-schema-owner@test.example.com",
		});
		member = await createTestUser({
			email: "entity-schema-member@test.example.com",
		});
		await addUserToOrganization(owner.id, org.id, "owner");
		await addUserToOrganization(member.id, org.id, "member");

		const oauthClient = await createTestOAuthClient();
		memberToken = (
			await createTestAccessToken(member.id, org.id, oauthClient.client_id, {
				scope: "mcp:read mcp:write profile:read",
			})
		).token;
		ownerWriteToken = (
			await createTestAccessToken(owner.id, org.id, oauthClient.client_id, {
				scope: "mcp:read mcp:write profile:read",
			})
		).token;
		ownerAdminToken = (
			await createTestAccessToken(owner.id, org.id, oauthClient.client_id, {
				scope: "mcp:read mcp:write mcp:admin profile:read",
			})
		).token;
	});

	beforeEach(async () => {
		await getDb()`DELETE FROM write_approval_policies WHERE organization_id = ${org.id}`;
	});

	async function setCreatePolicy(effect: "auto" | "approval" | "deny") {
		await upsertEntityApprovalPolicy(org.id, {
			resourceClass: "entity_schema",
			principalKind: "agent",
			effects: { create_type: effect },
		});
	}

	async function setUpdatePolicy(effect: "auto" | "approval" | "deny") {
		await upsertEntityApprovalPolicy(org.id, {
			resourceClass: "entity_schema",
			principalKind: "agent",
			effects: { update_type: effect },
		});
	}

	async function entityTypeExists(slug: string): Promise<boolean> {
		const rows = await getDb()`
			SELECT 1 FROM entity_types
			WHERE organization_id = ${org.id} AND slug = ${slug} AND deleted_at IS NULL
		`;
		return rows.length > 0;
	}

	async function propose(
		slug: string,
		token = ownerAdminToken,
	): Promise<PendingCreate> {
		const result = await mcpToolsCall<{
			success: boolean;
			return_value: PendingCreate;
		}>(
			"run_sdk",
			{
				script: `export default async (_ctx, client) => client.entitySchema.createType({ slug: ${JSON.stringify(slug)}, name: ${JSON.stringify(slug)} });`,
			},
			{ token, orgSlug: org.slug },
		);
		expect(result.success).toBe(true);
		return result.return_value;
	}

	async function resolveInApp(
		runId: number,
		decision: "approve" | "reject",
		token = ownerWriteToken,
	) {
		const viewResponse = await mcpRequest<any>(
			"tools/call",
			{
				name: "get_approval",
				arguments: { run_id: runId },
			},
			{ token, orgSlug: org.slug },
		);
		expect(viewResponse.result?.isError).not.toBe(true);
		expect(viewResponse.result?.structuredContent?.actions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "approve", tool: "resolve_approval" }),
				expect.objectContaining({ id: "reject", tool: "resolve_approval" }),
				expect.objectContaining({
					id: "review",
					href: expect.stringMatching(/^https?:\/\//),
				}),
			]),
		);
		const capability = viewResponse.result?._meta?.["lobu/approval-capability"];
		expect(typeof capability).toBe("string");

		const response = await mcpRequest<any>(
			"tools/call",
			{
				name: "resolve_approval",
				arguments: {
					run_id: runId,
					decision,
					_meta: { "lobu/approval-capability": capability },
				},
			},
			{ token, orgSlug: org.slug },
		);
		return { response, capability };
	}

	it("keeps a direct human owner create immediate", async () => {
		const client = await TestApiClient.for({
			organizationId: org.id,
			userId: owner.id,
			memberRole: "owner",
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		});
		const result = (await client.entity_schema.createType({
			slug: "direct-human-type",
			name: "Direct human type",
		})) as Record<string, unknown>;
		expect(result.status).toBe("applied");
		expect(await entityTypeExists("direct-human-type")).toBe(true);

		const directMember = await TestApiClient.for({
			organizationId: org.id,
			userId: member.id,
			memberRole: "member",
			scopes: ["mcp:read", "mcp:write"],
		});
		await expect(
			directMember.entity_schema.createType({
				slug: "direct-member-type",
				name: "Direct member type",
			}),
		).rejects.toThrow(/admin|owner/i);
		expect(await entityTypeExists("direct-member-type")).toBe(false);
	});

	it("requires policy approval and applies only after embedded human approval", async () => {
		await setCreatePolicy("approval");
		const pending = await propose("member-proposed-type");
		expect(pending).toMatchObject({
			schema_type: "entity_type",
			action: "create",
			status: "pending_approval",
			run_id: expect.any(Number),
			event_id: expect.any(Number),
			approval_url: expect.stringMatching(/^https?:\/\//),
			proposal: {
				version: 1,
				resource_class: "entity_schema",
				policy_action: "create_type",
				schema_type: "entity_type",
				action: "create",
				args: { slug: "member-proposed-type", name: "member-proposed-type" },
			},
			current: null,
		});
		expect(await entityTypeExists("member-proposed-type")).toBe(false);

		const [run] = await getDb()<
			[
				{
					approval_status: string;
					status: string;
					action_key: string;
					created_by_user_id: string;
				},
			]
		>`
			SELECT approval_status, status, action_key, created_by_user_id
			FROM runs WHERE id = ${pending.run_id} AND organization_id = ${org.id}
		`;
		expect(run).toEqual({
			approval_status: "pending",
			status: "pending",
			action_key: "manage_entity_schema",
			created_by_user_id: owner.id,
		});
		const [interaction] = await getDb()<
			[{ id: number; interaction_type: string; interaction_status: string }]
		>`
			SELECT id, interaction_type, interaction_status
			FROM events
			WHERE id = ${pending.event_id} AND run_id = ${pending.run_id}
		`;
		expect(interaction).toEqual({
			id: pending.event_id,
			interaction_type: "approval",
			interaction_status: "pending",
		});
		const unauthorized = await resolveInApp(
			pending.run_id,
			"approve",
			memberToken,
		);
		expect(unauthorized.response.result?.isError).toBe(true);
		expect(unauthorized.response.result?.content?.[0]?.text).toMatch(
			/admin or owner/i,
		);
		expect(await entityTypeExists("member-proposed-type")).toBe(false);

		const { response: resolved } = await resolveInApp(
			pending.run_id,
			"approve",
		);
		expect(resolved.result?.isError).not.toBe(true);
		expect(resolved.result?.structuredContent).toEqual(
			expect.objectContaining({
				actions: [],
				title: expect.stringMatching(/completed/i),
			}),
		);
		expect(await entityTypeExists("member-proposed-type")).toBe(true);

		const [created] = await getDb()<[{ created_by: string }]>`
			SELECT created_by FROM entity_types
			WHERE organization_id = ${org.id} AND slug = 'member-proposed-type'
		`;
		expect(created.created_by).toBe(owner.id);
		const [completed] = await getDb()<
			[{ approval_status: string; status: string }]
		>`
			SELECT approval_status, status FROM runs
			WHERE id = ${pending.run_id} AND organization_id = ${org.id}
		`;
		expect(completed).toEqual({
			approval_status: "approved",
			status: "completed",
		});
		const configEvents = await getDb()`
			SELECT id FROM events
			WHERE organization_id = ${org.id}
				AND semantic_type = 'change'
				AND metadata->>'category' = 'config'
				AND metadata->>'resource_kind' = 'entity-type'
				AND metadata->>'resource_id' = 'member-proposed-type'
				AND metadata->>'op' = 'created'
		`;
		expect(configEvents).toHaveLength(1);
	});

	it("rejects a policy-held mutation without applying and refuses replay", async () => {
		await setCreatePolicy("approval");
		const pending = await propose("admin-token-proposed-type", ownerAdminToken);
		expect(pending.status).toBe("pending_approval");
		expect(await entityTypeExists("admin-token-proposed-type")).toBe(false);

		const { response: rejected, capability } = await resolveInApp(
			pending.run_id,
			"reject",
			ownerAdminToken,
		);
		expect(rejected.result?.isError).not.toBe(true);
		expect(rejected.result?.structuredContent?.title).toMatch(/rejected/i);
		expect(await entityTypeExists("admin-token-proposed-type")).toBe(false);

		const replay = await mcpRequest<any>(
			"tools/call",
			{
				name: "resolve_approval",
				arguments: {
					run_id: pending.run_id,
					decision: "reject",
					_meta: { "lobu/approval-capability": capability },
				},
			},
			{ token: ownerAdminToken, orgSlug: org.slug },
		);
		expect(replay.result?.isError).toBe(true);
		expect(replay.result?.content?.[0]?.text).toMatch(/stale|pending/i);
	});

	it("keeps already-pending legacy MCP schema approvals resolvable", async () => {
		await setCreatePolicy("approval");
		const pending = await propose("legacy-pending-type");
		const sql = getDb();
		await sql`
			UPDATE runs
			SET action_input = ${sql.json({
				schema_type: "entity_type",
				action: "create",
				args: {
					schema_type: "entity_type",
					action: "create",
					slug: "legacy-pending-type",
					name: "legacy-pending-type",
				},
			})}
			WHERE id = ${pending.run_id} AND organization_id = ${org.id}
		`;

		const { response } = await resolveInApp(pending.run_id, "approve");
		expect(response.result?.isError).not.toBe(true);
		expect(await entityTypeExists("legacy-pending-type")).toBe(true);
	});

	it("rolls schema apply and run completion back when the terminal card fails", async () => {
		await setCreatePolicy("approval");
		const pending = await propose("terminal-card-rollback-type");
		const sql = getDb();
		await sql.unsafe(`
			CREATE OR REPLACE FUNCTION test_fail_schema_terminal_card() RETURNS trigger AS $fn$
			BEGIN
				IF NEW.interaction_type = 'approval' AND NEW.interaction_status = 'completed' THEN
					RAISE EXCEPTION 'simulated schema terminal card failure';
				END IF;
				RETURN NEW;
			END;
			$fn$ LANGUAGE plpgsql;
			CREATE TRIGGER test_fail_schema_terminal_card_trg
				BEFORE INSERT ON events
				FOR EACH ROW EXECUTE FUNCTION test_fail_schema_terminal_card();
		`);
		try {
			const { response } = await resolveInApp(pending.run_id, "approve");
			expect(response.result?.isError).toBe(true);
			expect(response.result?.content?.[0]?.text).toMatch(
				/terminal card failure/i,
			);
		} finally {
			await sql.unsafe(`
				DROP TRIGGER IF EXISTS test_fail_schema_terminal_card_trg ON events;
				DROP FUNCTION IF EXISTS test_fail_schema_terminal_card();
			`);
		}
		expect(await entityTypeExists("terminal-card-rollback-type")).toBe(false);
		const [run] = await sql<
			[{ status: string; approval_status: string }]
		>`SELECT status, approval_status FROM runs WHERE id = ${pending.run_id}`;
		expect(run).toEqual({ status: "pending", approval_status: "pending" });
	});

	it("keeps dry_run preview-only with no durable approval", async () => {
		const [{ count: before }] = await getDb()<[{ count: number }]>`
			SELECT count(*)::int AS count FROM runs
			WHERE organization_id = ${org.id} AND action_key = 'manage_entity_schema'
		`;
		const result = await mcpToolsCall<Record<string, unknown>>(
			"run_sdk",
			{
				dry_run: true,
				script:
					"export default async (_ctx, client) => client.entitySchema.createType({ slug: 'dry-run-type', name: 'Dry run type' });",
			},
			{ token: memberToken, orgSlug: org.slug },
		);
		expect(result.side_effect_preview).toEqual(expect.any(Array));
		expect(await entityTypeExists("dry-run-type")).toBe(false);
		const [{ count: after }] = await getDb()<[{ count: number }]>`
			SELECT count(*)::int AS count FROM runs
			WHERE organization_id = ${org.id} AND action_key = 'manage_entity_schema'
		`;
		expect(after).toBe(before);
	});

	it("fails a stale duplicate approval without creating another row", async () => {
		await setCreatePolicy("approval");
		const pending = await propose("stale-duplicate-type");
		const direct = await TestApiClient.for({
			organizationId: org.id,
			userId: owner.id,
			memberRole: "owner",
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		});
		await direct.entity_schema.createType({
			slug: "stale-duplicate-type",
			name: "Human won the race",
		});

		const { response: resolved } = await resolveInApp(
			pending.run_id,
			"approve",
		);
		expect(resolved.result?.isError).toBe(true);
		expect(resolved.result?.content?.[0]?.text).toMatch(/stale/i);
		const [{ count }] = await getDb()<[{ count: number }]>`
			SELECT count(*)::int AS count FROM entity_types
			WHERE organization_id = ${org.id} AND slug = 'stale-duplicate-type'
		`;
		expect(count).toBe(1);
		const [run] = await getDb()<[{ status: string; approval_status: string }]>`
			SELECT status, approval_status FROM runs
			WHERE id = ${pending.run_id} AND organization_id = ${org.id}
		`;
		expect(run).toEqual({ status: "pending", approval_status: "pending" });
	});

	it("does not let an old update approval overwrite a newer schema edit", async () => {
		const direct = await TestApiClient.for({
			organizationId: org.id,
			userId: owner.id,
			memberRole: "owner",
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		});
		await direct.entity_schema.createType({
			slug: "stale-update-type",
			name: "Original",
		});
		await setUpdatePolicy("approval");
		const proposed = await mcpToolsCall<{
			success: boolean;
			return_value: PendingCreate;
		}>(
			"run_sdk",
			{
				script:
					"export default async (_ctx, client) => client.entitySchema.updateType({ slug: 'stale-update-type', name: 'Approved old name' });",
			},
			{ token: ownerAdminToken, orgSlug: org.slug },
		);
		expect(proposed.success).toBe(true);
		expect(proposed.return_value.status).toBe("pending_approval");
		await direct.entity_schema.updateType({
			slug: "stale-update-type",
			name: "Newer human name",
		});

		const { response } = await resolveInApp(
			proposed.return_value.run_id,
			"approve",
		);
		expect(response.result?.isError).toBe(true);
		expect(response.result?.content?.[0]?.text).toMatch(/stale/i);
		const [row] = await getDb()<[{ name: string }]>`
			SELECT name FROM entity_types
			WHERE organization_id = ${org.id} AND slug = 'stale-update-type' AND deleted_at IS NULL
		`;
		expect(row.name).toBe("Newer human name");
	});

	it("returns a typed denial without creating a run or schema row", async () => {
		await setCreatePolicy("deny");
		const [{ count: before }] = await getDb()<
			[{ count: number }]
		>`SELECT count(*)::int AS count FROM runs
			WHERE organization_id = ${org.id} AND action_key = 'manage_entity_schema'`;
		const denied = await propose("policy-denied-type");
		expect(denied).toMatchObject({
			schema_type: "entity_type",
			action: "create",
			status: "denied",
		});
		expect(await entityTypeExists("policy-denied-type")).toBe(false);
		const [{ count: after }] = await getDb()<
			[{ count: number }]
		>`SELECT count(*)::int AS count FROM runs
			WHERE organization_id = ${org.id} AND action_key = 'manage_entity_schema'`;
		expect(after).toBe(before);
	});

	it("governs relationship type creation through the same approval run", async () => {
		await upsertEntityApprovalPolicy(org.id, {
			resourceClass: "entity_schema",
			principalKind: "agent",
			effects: { create_relationship_type: "approval" },
		});
		const proposed = await mcpToolsCall<{
			success: boolean;
			return_value: PendingCreate;
		}>(
			"run_sdk",
			{
				script:
					"export default async (_ctx, client) => client.entitySchema.createRelType({ slug: 'governed-rel', name: 'Governed relation' });",
			},
			{ token: ownerAdminToken, orgSlug: org.slug },
		);
		expect(proposed.success).toBe(true);
		expect(proposed.return_value.status).toBe("pending_approval");
		expect(
			await getDb()`SELECT id FROM entity_relationship_types
			WHERE organization_id = ${org.id} AND slug = 'governed-rel' AND deleted_at IS NULL`,
		).toHaveLength(0);
		const { response } = await resolveInApp(
			proposed.return_value.run_id,
			"approve",
		);
		expect(response.result?.isError).not.toBe(true);
		expect(
			await getDb()`SELECT id FROM entity_relationship_types
			WHERE organization_id = ${org.id} AND slug = 'governed-rel' AND deleted_at IS NULL`,
		).toHaveLength(1);
	});

	it("does not let a held relationship create overwrite a changed inverse", async () => {
		const direct = await TestApiClient.for({
			organizationId: org.id,
			userId: owner.id,
			memberRole: "owner",
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		});
		await direct.entity_schema.createRelType({
			slug: "inverse-before",
			name: "Inverse before",
		});
		await upsertEntityApprovalPolicy(org.id, {
			resourceClass: "entity_schema",
			principalKind: "agent",
			effects: { create_relationship_type: "approval" },
		});
		const proposed = await mcpToolsCall<{
			success: boolean;
			return_value: PendingCreate;
		}>(
			"run_sdk",
			{
				script:
					"export default async (_ctx, client) => client.entitySchema.createRelType({ slug: 'held-with-inverse', name: 'Held with inverse', inverse_type_slug: 'inverse-before' });",
			},
			{ token: ownerAdminToken, orgSlug: org.slug },
		);
		expect(proposed.return_value.status).toBe("pending_approval");
		await direct.entity_schema.updateRelType({
			slug: "inverse-before",
			name: "Inverse changed",
		});

		const { response } = await resolveInApp(
			proposed.return_value.run_id,
			"approve",
		);
		expect(response.result?.isError).toBe(true);
		expect(response.result?.content?.[0]?.text).toMatch(
			/inverse relationship type changed|stale/i,
		);
		expect(
			await getDb()`SELECT id FROM entity_relationship_types
			WHERE organization_id = ${org.id} AND slug = 'held-with-inverse' AND deleted_at IS NULL`,
		).toHaveLength(0);
	});

	it("governs relationship rules as relationship-type updates", async () => {
		const direct = await TestApiClient.for({
			organizationId: org.id,
			userId: owner.id,
			memberRole: "owner",
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		});
		await direct.entity_schema.createType({
			slug: "rule-source",
			name: "Rule source",
		});
		await direct.entity_schema.createType({
			slug: "rule-target",
			name: "Rule target",
		});
		await direct.entity_schema.createRelType({
			slug: "ruled-rel",
			name: "Ruled relation",
		});
		await upsertEntityApprovalPolicy(org.id, {
			resourceClass: "entity_schema",
			principalKind: "agent",
			effects: { update_relationship_type: "deny" },
		});
		const denied = await mcpToolsCall<{
			success: boolean;
			return_value: Record<string, unknown>;
		}>(
			"run_sdk",
			{
				script:
					"export default async (_ctx, client) => client.entitySchema.addRule({ slug: 'ruled-rel', source_entity_type_slug: 'rule-source', target_entity_type_slug: 'rule-target' });",
			},
			{ token: ownerAdminToken, orgSlug: org.slug },
		);
		expect(denied.success).toBe(true);
		expect(denied.return_value.status).toBe("denied");
		expect(
			await getDb()`SELECT r.id FROM entity_relationship_type_rules r
			JOIN entity_relationship_types rt ON rt.id = r.relationship_type_id
			WHERE rt.organization_id = ${org.id} AND rt.slug = 'ruled-rel' AND r.deleted_at IS NULL`,
		).toHaveLength(0);
	});
});
