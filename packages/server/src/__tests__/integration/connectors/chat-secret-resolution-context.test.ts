/**
 * Chat config updates run from tool/SDK paths that carry an explicit tenant but
 * do not necessarily have request middleware's AsyncLocalStorage context.
 * Stored credentials are org-scoped `secret://` refs, so resolving them before
 * installing that explicit tenant searches only the global secret bucket and
 * rejects an otherwise unchanged Google Chat configuration.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import { updateChatConnection } from "../../../gateway/connections/chat-connection-service";
import { ChatInstanceManager } from "../../../gateway/connections/chat-instance-manager";
import {
	resolveSecretValue,
	SecretStoreRegistry,
} from "../../../gateway/secrets";
import { __setChatInstanceManagerForTests } from "../../../lobu/gateway";
import { orgContext } from "../../../lobu/stores/org-context";
import { PostgresSecretStore } from "../../../lobu/stores/postgres-secret-store";
import { createPostgresAgentConnectionStore } from "../../../lobu/stores/postgres-stores";
import { TestWorkspace } from "../../setup/test-mcp-client";

const ENCRYPTION_KEY =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const RUNTIME_ID = "gchat-secret-context";
const SECRET_NAME = `connections/${RUNTIME_ID}/credentials`;
const PROJECT_NUMBER = "1234567890";
const CREDENTIALS = JSON.stringify({
	client_email: "bot@example.invalid",
	private_key: "synthetic-private-key",
});

describe("chat config secret resolution context", () => {
	let workspace: TestWorkspace;
	let connectionId: number;
	let secretRef: string;
	let secretStore: SecretStoreRegistry;

	beforeAll(async () => {
		process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
		workspace = await TestWorkspace.create({
			name: "Chat Secret Context Org",
		});

		const postgresSecrets = new PostgresSecretStore();
		secretStore = new SecretStoreRegistry(postgresSecrets, {
			secret: postgresSecrets,
		});
		secretRef = await orgContext.run(
			{ organizationId: workspace.org.id },
			() => secretStore.put(SECRET_NAME, CREDENTIALS),
		);

		const connectionStore = createPostgresAgentConnectionStore();
		const manager = new ChatInstanceManager();
		(manager as unknown as { connectionStore: unknown }).connectionStore =
			connectionStore;
		(manager as unknown as { services: unknown }).services = {
			getSecretStore: () => secretStore,
		};
		__setChatInstanceManagerForTests(manager);

		await orgContext.run({ organizationId: workspace.org.id }, () =>
			connectionStore.saveConnection({
				id: RUNTIME_ID,
				platform: "gchat",
				organizationId: workspace.org.id,
				config: {
					platform: "gchat",
					credentials: secretRef,
					googleChatProjectNumber: PROJECT_NUMBER,
				},
				settings: { allowGroups: true },
				metadata: {},
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);

		const rows = (await getDb()`
			SELECT id FROM connections
			WHERE organization_id = ${workspace.org.id}
			  AND slug = ${`agentconn-${RUNTIME_ID}`}
			  AND deleted_at IS NULL
		`) as Array<{ id: number }>;
		if (!rows[0]) throw new Error("Google Chat test connection was not seeded");
		connectionId = Number(rows[0].id);
	}, 60_000);

	afterAll(async () => {
		__setChatInstanceManagerForTests(null);
		if (!workspace) return;
		const sql = getDb();
		await sql`DELETE FROM connections WHERE organization_id = ${workspace.org.id}`;
		await sql`
			DELETE FROM agent_secrets
			WHERE organization_id = ${workspace.org.id} AND name = ${SECRET_NAME}
		`;
	});

	it("round-trips a redacted Google Chat credential without ambient org context", async () => {
		await expect(
			updateChatConnection({
				organizationId: workspace.org.id,
				connectionId,
				config: {
					credentials: "__LOBU_REDACTED__",
					googleChatProjectNumber: PROJECT_NUMBER,
				},
			}),
		).resolves.toBeUndefined();

		const rows = (await getDb()`
			SELECT config FROM connections
			WHERE id = ${connectionId} AND organization_id = ${workspace.org.id}
		`) as Array<{ config: Record<string, unknown> }>;
		expect(rows[0]?.config.credentials).toBe(secretRef);
		await expect(
			orgContext.run({ organizationId: workspace.org.id }, () =>
				resolveSecretValue(secretStore, secretRef),
			),
		).resolves.toBe(CREDENTIALS);
	});
});
