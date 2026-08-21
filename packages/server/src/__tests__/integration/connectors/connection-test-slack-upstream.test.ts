/**
 * Slack connections.test must cross the provider boundary. Stored metadata is
 * useful for routing, but it cannot prove that the managed bot credential is
 * live or which Grid workspace/enterprise Slack currently assigns to it.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../index";
import { ChatInstanceManager } from "../../../gateway/connections/chat-instance-manager";
import { SecretStoreRegistry } from "../../../gateway/secrets";
import {
	__setChatInstanceManagerForTests,
} from "../../../lobu/gateway";
import { PostgresSecretStore } from "../../../lobu/stores/postgres-secret-store";
import { createPostgresAgentConnectionStore } from "../../../lobu/stores/postgres-stores";
import { orgContext } from "../../../lobu/stores/org-context";
import { manageConnections } from "../../../tools/admin/manage_connections";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { seedOwnerContext } from "../../setup/test-fixtures";

const ENCRYPTION_KEY =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const realFetch = globalThis.fetch;

async function seedManagedSlackConnection(options: {
	organizationId: string;
	runtimeId: string;
	externalTenantId: string;
	teamId: string;
	enterpriseId?: string;
	isEnterpriseInstall: boolean;
}): Promise<{ connectionId: number; token: string }> {
	const connectionStore = createPostgresAgentConnectionStore();
	const postgresSecrets = new PostgresSecretStore();
	const secretStore = new SecretStoreRegistry(postgresSecrets, {
		secret: postgresSecrets,
	});
	const token = `xoxb-${options.runtimeId}-secret`;
	const botToken = await orgContext.run(
		{ organizationId: options.organizationId },
		() => secretStore.put(`connections/${options.runtimeId}/botToken`, token),
	);
	const manager = new ChatInstanceManager() as unknown as {
		services: unknown;
		connectionStore: unknown;
	};
	manager.services = { getSecretStore: () => secretStore };
	manager.connectionStore = connectionStore;
	__setChatInstanceManagerForTests(manager);

	await orgContext.run({ organizationId: options.organizationId }, () =>
		connectionStore.saveConnection({
			id: options.runtimeId,
			platform: "slack",
			organizationId: options.organizationId,
			config: {
				platform: "slack",
				botToken,
			},
			settings: { allowGroups: true },
			metadata: {
				teamId: options.teamId,
				...(options.enterpriseId
					? { enterpriseId: options.enterpriseId }
					: {}),
				isEnterpriseInstall: options.isEnterpriseInstall,
			},
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);
	await getTestDb()`
		UPDATE connections
		SET external_tenant_id = ${options.externalTenantId}
		WHERE slug = ${options.runtimeId}
		  AND organization_id = ${options.organizationId}
	`;
	const [row] = await getTestDb()<{ id: number }[]>`
		SELECT id
		FROM connections
		WHERE slug = ${options.runtimeId}
		  AND organization_id = ${options.organizationId}
	`;
	if (!row) throw new Error("Managed Slack test connection was not seeded");
	return { connectionId: Number(row.id), token };
}

describe("connections.test — live Slack identity", () => {
	beforeAll(() => {
		process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		__setChatInstanceManagerForTests(null);
	});

	it("probes an org-wide token and keeps workspace T distinct from enterprise E", async () => {
		const { org, ctx } = await seedOwnerContext({
			orgName: "Slack Grid Probe Org",
		});
		const { connectionId, token } = await seedManagedSlackConnection({
			organizationId: org.id,
			runtimeId: "slackinst-grid-probe",
			externalTenantId: "E0ENTERPRISE",
			teamId: "E0ENTERPRISE",
			enterpriseId: "E0ENTERPRISE",
			isEnterpriseInstall: true,
		});
		globalThis.fetch = vi.fn(async (url, init) => {
			expect(url).toBe("https://slack.com/api/auth.test");
			expect((init?.headers as Record<string, string>).Authorization).toBe(
				`Bearer ${token}`,
			);
			return new Response(
				JSON.stringify({
					ok: true,
					team_id: "T0WORKSPACE",
					enterprise_id: "E0ENTERPRISE",
					is_enterprise_install: true,
				}),
			);
		}) as typeof fetch;

		const result = await manageConnections(
			{ action: "test", connection_id: connectionId },
			{} as Env,
			ctx,
		);

		expect(result).toMatchObject({
			action: "test",
			status: "ok",
		});
		expect(String((result as { message: string }).message)).toContain(
			"workspace T0WORKSPACE",
		);
		expect(String((result as { message: string }).message)).toContain(
			"enterprise E0ENTERPRISE",
		);
		expect(JSON.stringify(result)).not.toContain(token);
	});

	it("rejects a sibling workspace for a workspace-scoped install", async () => {
		const { org, ctx } = await seedOwnerContext({
			orgName: "Slack Workspace Probe Org",
		});
		const { connectionId } = await seedManagedSlackConnection({
			organizationId: org.id,
			runtimeId: "slackinst-workspace-probe",
			externalTenantId: "T0EXPECTED",
			teamId: "T0EXPECTED",
			enterpriseId: "E0ENTERPRISE",
			isEnterpriseInstall: false,
		});
		globalThis.fetch = vi.fn(async () =>
			new Response(
				JSON.stringify({
					ok: true,
					team_id: "T0SIBLING",
					enterprise_id: "E0ENTERPRISE",
					is_enterprise_install: false,
				}),
			),
		) as typeof fetch;

		const result = await manageConnections(
			{ action: "test", connection_id: connectionId },
			{} as Env,
			ctx,
		);

		expect(result).toMatchObject({
			action: "test",
			status: "error",
			error_code: "AUTH_INVALID",
			retryable: false,
		});
		expect(String((result as { message: string }).message)).toContain(
			"T0SIBLING",
		);
	});
});
