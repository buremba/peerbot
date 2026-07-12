import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import { upsertByoChatConnection } from "../../../gateway/connections/chat-connection-service";
import {
	resolveSecretValue,
	SecretStoreRegistry,
} from "../../../gateway/secrets/index";
import { createPostgresAppInstallationStore } from "../../../lobu/stores/app-installation-store";
import { orgContext } from "../../../lobu/stores/org-context";
import { PostgresSecretStore } from "../../../lobu/stores/postgres-secret-store";
import {
	getSlackInstallById,
	upsertSlackInstallByTeam,
} from "../../../lobu/stores/slack-installations";
import { TestWorkspace } from "../../setup/test-mcp-client";

const ENCRYPTION_KEY =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("BYO chat stable-id namespace", () => {
	let workspace: TestWorkspace;
	let secretStore: SecretStoreRegistry;

	beforeAll(async () => {
		process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
		workspace = await TestWorkspace.create({
			name: "Managed ID Collision Org",
		});

		const postgresSecrets = new PostgresSecretStore();
		secretStore = new SecretStoreRegistry(postgresSecrets, {
			secret: postgresSecrets,
		});
	});

	afterAll(async () => {
		const sql = getDb();
		await sql`DELETE FROM connections WHERE organization_id = ${workspace.org.id}`;
		await sql`DELETE FROM app_installations WHERE organization_id = ${workspace.org.id}`;
	});

	it("rejects slackinst-* before a BYO apply can overwrite a managed row or secret", async () => {
		const installationStore = createPostgresAppInstallationStore();
		const install = await upsertSlackInstallByTeam(
			installationStore,
			secretStore,
			workspace.org.id,
			"TMANAGEDCOLLISION",
			{
				teamName: "Managed Collision Co",
				botUserId: "UMANAGEDCOLLISION",
				botToken: "xoxb-managed-original",
			},
		);

		const sql = getDb();
		const beforeRows = (await sql`
			SELECT connector_key, credential_mode, status, config, display_name
			FROM connections
			WHERE organization_id = ${workspace.org.id} AND slug = ${install.id}
			LIMIT 1
		`) as Array<{
			connector_key: string;
			credential_mode: string;
			status: string;
			config: Record<string, unknown>;
			display_name: string | null;
		}>;
		expect(beforeRows).toHaveLength(1);
		expect(beforeRows[0].credential_mode).toBe("managed");
		const beforeInstall = await getSlackInstallById(
			installationStore,
			install.id,
		);
		expect(beforeInstall).not.toBeNull();
		const beforeToken = await orgContext.run(
			{ organizationId: workspace.org.id },
			() => resolveSecretValue(secretStore, beforeInstall?.config.botToken),
		);

		let rejection: unknown;
		try {
			await upsertByoChatConnection({
				organizationId: workspace.org.id,
				platform: "slack",
				stableId: install.id,
				displayName: "Attacker BYO",
				config: {
					botToken: "xoxb-byo-attacker",
					signingSecret: "byo-attacker-signing-secret",
				},
			});
		} catch (error) {
			rejection = error;
		}
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toMatch(
			/reserved for managed Slack installations/,
		);

		const afterRows = (await sql`
			SELECT connector_key, credential_mode, status, config, display_name
			FROM connections
			WHERE organization_id = ${workspace.org.id} AND slug = ${install.id}
			LIMIT 1
		`) as typeof beforeRows;
		expect(afterRows).toEqual(beforeRows);

		const afterInstall = await getSlackInstallById(
			installationStore,
			install.id,
		);
		expect(afterInstall).toEqual(beforeInstall);
		const afterToken = await orgContext.run(
			{ organizationId: workspace.org.id },
			() => resolveSecretValue(secretStore, afterInstall?.config.botToken),
		);
		expect(afterToken).toBe(beforeToken);
		expect(afterToken).toBe("xoxb-managed-original");
	});
});
