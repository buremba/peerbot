/**
 * MCP entitySchema.createType approval lifecycle.
 *
 * This is intentionally a wire-level test for proposal creation: the caller
 * enters through JSON-RPC tools/call -> run_sdk -> ClientSDK, which is the same
 * path MCP Inspector and ChatGPT use. Approval resolution enters through the
 * existing MCP App tools, proving the held proposal is applied only after a
 * human owner uses the capability-bound confirmation surface.
 */

import { beforeAll, describe, expect, it } from "vitest";
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
		owner = await createTestUser({ email: "entity-schema-owner@test.example.com" });
		member = await createTestUser({ email: "entity-schema-member@test.example.com" });
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

	async function entityTypeExists(slug: string): Promise<boolean> {
		const rows = await getDb()`
			SELECT 1 FROM entity_types
			WHERE organization_id = ${org.id} AND slug = ${slug} AND deleted_at IS NULL
		`;
		return rows.length > 0;
	}

	async function propose(slug: string, token = memberToken): Promise<PendingCreate> {
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
				expect.objectContaining({ id: "review", href: expect.stringMatching(/^https?:\/\//) }),
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
		expect(result.status).toBeUndefined();
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
		).rejects.toThrow(/admin or owner/i);
		expect(await entityTypeExists("direct-member-type")).toBe(false);
	});

	it("lets an mcp:write member propose and applies only after embedded human approval", async () => {
		const pending = await propose("member-proposed-type");
		expect(pending).toMatchObject({
			schema_type: "entity_type",
			action: "create",
			status: "pending_approval",
			run_id: expect.any(Number),
			event_id: expect.any(Number),
			approval_url: expect.stringMatching(/^https?:\/\//),
			proposal: {
				schema_type: "entity_type",
				action: "create",
				args: { slug: "member-proposed-type", name: "member-proposed-type" },
			},
			current: null,
		});
		expect(await entityTypeExists("member-proposed-type")).toBe(false);

		const [run] = await getDb()<
			[{ approval_status: string; status: string; action_key: string; created_by_user_id: string }]
		>`
			SELECT approval_status, status, action_key, created_by_user_id
			FROM runs WHERE id = ${pending.run_id} AND organization_id = ${org.id}
		`;
		expect(run).toEqual({
			approval_status: "pending",
			status: "pending",
			action_key: "manage_entity_schema",
			created_by_user_id: member.id,
		});
		const unauthorized = await resolveInApp(pending.run_id, "approve", memberToken);
		expect(unauthorized.response.result?.isError).toBe(true);
		expect(unauthorized.response.result?.content?.[0]?.text).toMatch(/admin or owner/i);
		expect(await entityTypeExists("member-proposed-type")).toBe(false);

		const { response: resolved } = await resolveInApp(pending.run_id, "approve");
		expect(resolved.result?.isError).not.toBe(true);
		expect(resolved.result?.structuredContent).toEqual(
			expect.objectContaining({ actions: [], title: expect.stringMatching(/completed/i) }),
		);
		expect(await entityTypeExists("member-proposed-type")).toBe(true);

		const [created] = await getDb()<[{ created_by: string }]>`
			SELECT created_by FROM entity_types
			WHERE organization_id = ${org.id} AND slug = 'member-proposed-type'
		`;
		expect(created.created_by).toBe(member.id);
	});

	it("queues even with mcp:admin, rejects without applying, and refuses replay", async () => {
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

		const { response: resolved } = await resolveInApp(pending.run_id, "approve");
		expect(resolved.result?.isError).not.toBe(true);
		expect(resolved.result?.structuredContent?.title).toMatch(/failed/i);
		const [{ count }] = await getDb()<[{ count: number }]>`
			SELECT count(*)::int AS count FROM entity_types
			WHERE organization_id = ${org.id} AND slug = 'stale-duplicate-type'
		`;
		expect(count).toBe(1);
		const [run] = await getDb()<[{ status: string; approval_status: string }]>`
			SELECT status, approval_status FROM runs
			WHERE id = ${pending.run_id} AND organization_id = ${org.id}
		`;
		expect(run).toEqual({ status: "failed", approval_status: "approved" });
	});
});
