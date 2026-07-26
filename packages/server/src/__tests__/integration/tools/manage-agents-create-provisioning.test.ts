/**
 * A freshly created agent must be RUNNABLE on a deployment configured purely by
 * environment API keys.
 *
 * The bug: three paths insert an `agents` row, and only two of them baked in a
 * `models` list resolved from the deployment's system keys:
 *   - `ensureDefaultAgent` / `ensureBuilderAgent` call
 *     `resolveSystemKeyProvidersAndModel()` and persist the result.
 *   - `manage_agents` create persisted `models` ONLY when the caller passed an
 *     explicit `default_model`.
 *
 * The runtime fallback is `agent.models[0] → org default row → nothing`, and the
 * org-default tail reads `inference_providers WHERE is_default` — a DB ROW that
 * environment API keys never create. So on an env-key-only deployment an agent
 * made through `manage_agents create` resolved NO model, never completed a turn,
 * and its Behavior failed with "Agent reply finished without calling
 * completeWindow" — while the SAME Behavior succeeded on an older agent that had
 * been provisioned through `ensureDefaultAgent`.
 *
 * `pre_approved_tools` had the same shape of divergence: the web create route
 * seeds `/mcp/lobu-memory/tools/*` so the agent may call `query_sdk` / `run_sdk`
 * (which is how a Behavior reaches `completeWindow`) without an interactive
 * approval, and the tool path seeded nothing.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureDefaultAgent } from "../../../auth/default-provisioning";
import type { Env } from "../../../index";
import { orgContext } from "../../../lobu/stores/org-context";
import { createPostgresAgentConfigStore } from "../../../lobu/stores/postgres-stores";
import { createInferenceProvider } from "../../../lobu/stores/provider-secrets";
import type { AuthContext } from "../../../tools/execute";
import { executeTool } from "../../../tools/execute";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
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

type ModelInfo = {
	effective_model: string | null;
	source: "agent" | "org_default" | "none";
	not_runnable: boolean;
};

// packages/server/src/__tests__/integration/tools → repo root.
const PROVIDERS_JSON = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../../../../config/providers.json",
);

describe("manage_agents create — env-key deployment provisions a runnable agent", () => {
	let orgId: string;
	let ownerCtx: AuthContext;
	const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
	const savedRegistryPath = process.env.LOBU_PROVIDER_REGISTRY_PATH;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();

		// The prod shape this bug reproduces: the deployment's ONLY model
		// credential is an environment API key. There is deliberately no
		// `inference_providers` row (and therefore no org default), because env
		// keys never create one. The registry path is pinned so the catalog's
		// `defaultModel` resolves to a concrete ref (as it does in prod) rather
		// than an `__unresolved__` sentinel.
		process.env.ANTHROPIC_API_KEY = "sk-ant-test-system-key";
		process.env.LOBU_PROVIDER_REGISTRY_PATH = PROVIDERS_JSON;

		const org = await createTestOrganization({
			name: "env-key create provisioning",
		});
		orgId = org.id;
		const owner = await createTestUser({ email: "envkey-owner@test.com" });
		await addUserToOrganization(owner.id, org.id, "owner");
		ownerCtx = {
			organizationId: org.id,
			tokenOrganizationId: org.id,
			userId: owner.id,
			memberRole: "owner",
			agentId: null,
			requestedAgentId: null,
			isAuthenticated: true,
			clientId: null,
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
			tokenType: "oauth",
			requestUrl: `http://localhost/api/${org.id}`,
			baseUrl: "",
			scopedToOrg: true,
			allowCrossOrg: false,
		};
	});

	afterAll(() => {
		if (savedAnthropicKey === undefined) {
			delete process.env.ANTHROPIC_API_KEY;
		} else {
			process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
		}
		if (savedRegistryPath === undefined) {
			delete process.env.LOBU_PROVIDER_REGISTRY_PATH;
		} else {
			process.env.LOBU_PROVIDER_REGISTRY_PATH = savedRegistryPath;
		}
	});

	it("the org has NO inference_providers default row (env keys never create one)", async () => {
		const sql = getTestDb();
		const rows = await sql`
			SELECT 1 FROM inference_providers
			WHERE organization_id = ${orgId} AND is_default AND deleted_at IS NULL
		`;
		expect(rows.length).toBe(0);
	});

	it("create WITHOUT default_model bakes the system-key models list ⇒ runnable", async () => {
		const res = (await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "envkey-bot", name: "Env Key Bot" },
			TEST_ENV,
			ownerCtx,
		)) as { created: boolean; model: ModelInfo };

		expect(res.created).toBe(true);
		// THE BUG: this resolved { source: 'none', not_runnable: true } because
		// `models` was left NULL and no org-default row exists to fall back to.
		expect(res.model.not_runnable).toBe(false);
		expect(res.model.source).toBe("agent");
		expect(res.model.effective_model).toBe("claude/claude-sonnet-5");

		// The list is persisted on the row — the same single source of truth
		// `ensureDefaultAgent` writes, not a read-time inference.
		const sql = getTestDb();
		const rows = await sql`
			SELECT models FROM agents
			WHERE organization_id = ${orgId} AND id = 'envkey-bot'
		`;
		expect(rows[0]?.models).toContain("claude/claude-sonnet-5");
	});

	it("create seeds the lobu-memory pre-approval so query_sdk / run_sdk need no interactive approval", async () => {
		const sql = getTestDb();
		const rows = await sql`
			SELECT pre_approved_tools FROM agents
			WHERE organization_id = ${orgId} AND id = 'envkey-bot'
		`;
		// A Behavior reaches completeWindow through run_sdk on the lobu-memory
		// MCP. The web create route already seeds this; the tool path did not.
		expect(rows[0]?.pre_approved_tools).toContain("/mcp/lobu-memory/tools/*");
	});

	it("an explicit default_model still wins over the system-key default", async () => {
		// Regression guard: baking a default must not override a caller's choice.
		// The ref is validated against the org's providers, so this uses a real
		// `inference_providers` row rather than the env-key provider (whose slug
		// resolves through the module registry, which is empty in-process here).
		await orgContext.run({ organizationId: orgId }, async () => {
			await createInferenceProvider({
				organizationId: orgId,
				slug: "myco",
				kind: "openai",
				apiKey: "sk-test",
				capabilities: { text: { model: "myco-large" } },
			});
		});
		const res = (await executeTool(
			"manage_agents",
			{
				action: "create",
				agent_id: "envkey-pinned-bot",
				name: "Pinned",
				default_model: "myco/myco-large",
			},
			TEST_ENV,
			ownerCtx,
		)) as { created: boolean; model: ModelInfo };
		expect(res.model.effective_model).toBe("myco/myco-large");
		expect(res.model.source).toBe("agent");

		// ONLY the caller's pin — the system-key list must not have been merged in.
		const sql = getTestDb();
		const rows = await sql`
			SELECT models FROM agents
			WHERE organization_id = ${orgId} AND id = 'envkey-pinned-bot'
		`;
		expect(rows[0]?.models).toEqual(["myco/myco-large"]);
	});

	it("CONTRAST: an ensureDefaultAgent-provisioned agent in the SAME env is runnable", async () => {
		// This is the asymmetry the user hit — the older agent worked because its
		// provisioning path baked the models list in.
		const org = await createTestOrganization({ name: "env-key default agent" });
		await ensureDefaultAgent(org.id);
		const sql = getTestDb();
		const rows = await sql`
			SELECT models FROM agents WHERE organization_id = ${org.id}
		`;
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[0]?.models).toContain("claude/claude-sonnet-5");
	});

	// ── The shared UPSERT (`saveMetadata`) ────────────────────────────────────
	// Reached by `AgentMetadataStore.createAgent`, i.e. the `POST /api/v1/agents`
	// route mounted at gateway.ts. It is a genuine sixth insert site, and it is
	// ALSO the update path (`updateMetadata` reads-then-re-saves), so the two
	// cases below pin both halves of the contract.

	it("saveMetadata seeds provisioning defaults on a FRESH insert", async () => {
		const store = createPostgresAgentConfigStore();
		await orgContext.run({ organizationId: orgId }, async () => {
			await store.saveMetadata("store-fresh-bot", {
				agentId: "store-fresh-bot",
				name: "Store Fresh Bot",
				owner: { platform: "external", userId: "u-store" },
				createdAt: Date.now(),
			});
		});

		const sql = getTestDb();
		const rows = await sql`
			SELECT models, pre_approved_tools FROM agents
			WHERE organization_id = ${orgId} AND id = 'store-fresh-bot'
		`;
		expect(rows[0]?.models).toContain("claude/claude-sonnet-5");
		expect(rows[0]?.pre_approved_tools).toContain("/mcp/lobu-memory/tools/*");
	});

	it("a re-save does NOT clobber a curated models list or pre-approvals", async () => {
		// `updateMetadata` (rename, lastUsedAt touch, …) funnels back through the
		// same UPSERT. Seeding on INSERT must not leak into the CONFLICT path —
		// otherwise every metadata touch would reset an admin's allow-list.
		const store = createPostgresAgentConfigStore();
		const sql = getTestDb();
		await orgContext.run({ organizationId: orgId }, async () => {
			await store.saveMetadata("store-curated-bot", {
				agentId: "store-curated-bot",
				name: "v1",
				owner: { platform: "external", userId: "u-store" },
				createdAt: Date.now(),
			});
		});
		// An admin curates the allow-list and narrows the pre-approvals.
		await sql`
			UPDATE agents
			SET models = ${sql.json(["myco/myco-large"])},
			    pre_approved_tools = ${sql.json(["/mcp/lobu-memory/tools/query_sdk"])}
			WHERE organization_id = ${orgId} AND id = 'store-curated-bot'
		`;

		// A later metadata-only edit (the rename path) must leave both alone.
		await orgContext.run({ organizationId: orgId }, async () => {
			await store.updateMetadata("store-curated-bot", { name: "v2" });
		});

		const rows = await sql`
			SELECT name, models, pre_approved_tools FROM agents
			WHERE organization_id = ${orgId} AND id = 'store-curated-bot'
		`;
		expect(rows[0]?.name).toBe("v2");
		expect(rows[0]?.models).toEqual(["myco/myco-large"]);
		expect(rows[0]?.pre_approved_tools).toEqual([
			"/mcp/lobu-memory/tools/query_sdk",
		]);
	});
});
