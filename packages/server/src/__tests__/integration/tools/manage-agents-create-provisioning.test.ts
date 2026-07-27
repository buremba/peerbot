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
import {
	createInferenceProvider,
	setInferenceProviderDefault,
} from "../../../lobu/stores/provider-secrets";
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
		// Seeding on INSERT must not leak into the CONFLICT path — otherwise a
		// re-save of an existing agent would reset an admin's allow-list. Driven
		// through `saveMetadata` itself (the UPSERT), since that is the only
		// caller that can reach the ON CONFLICT branch.
		const store = createPostgresAgentConfigStore();
		const sql = getTestDb();
		const metadata = {
			agentId: "store-curated-bot",
			name: "v1",
			owner: { platform: "external", userId: "u-store" },
			createdAt: Date.now(),
		};
		await orgContext.run({ organizationId: orgId }, async () => {
			await store.saveMetadata("store-curated-bot", metadata);
		});
		// An admin curates the allow-list and narrows the pre-approvals.
		await sql`
			UPDATE agents
			SET models = ${sql.json(["myco/myco-large"])},
			    pre_approved_tools = ${sql.json(["/mcp/lobu-memory/tools/query_sdk"])}
			WHERE organization_id = ${orgId} AND id = 'store-curated-bot'
		`;

		// A re-save of the SAME id takes the ON CONFLICT branch: it updates the
		// metadata columns and must leave the curated policy columns alone.
		await orgContext.run({ organizationId: orgId }, async () => {
			await store.saveMetadata("store-curated-bot", { ...metadata, name: "v2" });
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

	it("updateMetadata renames WITHOUT touching models or pre-approvals", async () => {
		// The direct-UPDATE path: a metadata-only edit must not run provisioning
		// at all, and must leave the policy columns untouched.
		const store = createPostgresAgentConfigStore();
		const sql = getTestDb();
		await orgContext.run({ organizationId: orgId }, async () => {
			await store.saveMetadata("store-rename-bot", {
				agentId: "store-rename-bot",
				name: "before",
				description: "keep me",
				owner: { platform: "external", userId: "u-store" },
				createdAt: Date.now(),
			});
		});
		await sql`
			UPDATE agents SET models = ${sql.json(["myco/myco-large"])}
			WHERE organization_id = ${orgId} AND id = 'store-rename-bot'
		`;

		await orgContext.run({ organizationId: orgId }, async () => {
			await store.updateMetadata("store-rename-bot", { name: "after" });
		});

		const rows = await sql`
			SELECT name, description, models FROM agents
			WHERE organization_id = ${orgId} AND id = 'store-rename-bot'
		`;
		expect(rows[0]?.name).toBe("after");
		// COALESCE keeps an omitted field at its current value.
		expect(rows[0]?.description).toBe("keep me");
		expect(rows[0]?.models).toEqual(["myco/myco-large"]);
	});
});

/**
 * The other half of the ordering: an org that has DELIBERATELY configured a
 * default model. Seeding a system-key ref into `models` here would be persisted
 * at `models[0]`, which `resolveAgentModelInfo` checks FIRST — permanently
 * shadowing the org default, so an admin's later change to it would silently
 * never reach agents created before that change. A new agent must inherit
 * instead: runnable, but through the org default, not around it.
 *
 * The env key is set here too, so the ONLY thing distinguishing this suite from
 * the one above is the presence of the org default row.
 */
describe("agent create — an org default is inherited, never shadowed", () => {
	let orgId: string;
	let ownerCtx: AuthContext;
	const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
	const savedRegistryPath = process.env.LOBU_PROVIDER_REGISTRY_PATH;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		process.env.ANTHROPIC_API_KEY = "sk-ant-test-system-key";
		process.env.LOBU_PROVIDER_REGISTRY_PATH = PROVIDERS_JSON;

		const org = await createTestOrganization({ name: "org-default provisioning" });
		orgId = org.id;
		const owner = await createTestUser({ email: "orgdefault-owner@test.com" });
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

		// The deliberate org-level policy this suite protects.
		await orgContext.run({ organizationId: org.id }, async () => {
			await createInferenceProvider({
				organizationId: org.id,
				slug: "myco",
				kind: "openai",
				apiKey: "sk-test",
				capabilities: { text: { model: "myco-large" } },
			});
			await setInferenceProviderDefault(org.id, "myco");
		});
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

	it("manage_agents create resolves via the ORG DEFAULT, not a baked system-key model", async () => {
		const res = (await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "inherits-bot", name: "Inherits" },
			TEST_ENV,
			ownerCtx,
		)) as { created: boolean; model: ModelInfo };

		expect(res.created).toBe(true);
		expect(res.model.not_runnable).toBe(false);
		// THE REGRESSION: this was 'agent' / 'claude/claude-sonnet-5', because
		// provisioning baked the system-key list in regardless of the org default.
		expect(res.model.source).toBe("org_default");
		expect(res.model.effective_model).toBe("myco/myco-large");

		// Nothing pinned on the row — that absence IS the inheritance.
		const sql = getTestDb();
		const rows = await sql`
			SELECT models FROM agents
			WHERE organization_id = ${orgId} AND id = 'inherits-bot'
		`;
		const models = rows[0]?.models as string[] | null;
		expect(models === null || models.length === 0).toBe(true);
	});

	it("the shared saveMetadata UPSERT also inherits the org default", async () => {
		const store = createPostgresAgentConfigStore();
		await orgContext.run({ organizationId: orgId }, async () => {
			await store.saveMetadata("store-inherits-bot", {
				agentId: "store-inherits-bot",
				name: "Store Inherits",
				owner: { platform: "external", userId: "u-store" },
				createdAt: Date.now(),
			});
		});

		const sql = getTestDb();
		const rows = await sql`
			SELECT models, pre_approved_tools FROM agents
			WHERE organization_id = ${orgId} AND id = 'store-inherits-bot'
		`;
		const models = rows[0]?.models as string[] | null;
		expect(models === null || models.length === 0).toBe(true);
		// The pre-approval is unconditional — it is not model policy.
		expect(rows[0]?.pre_approved_tools).toContain("/mcp/lobu-memory/tools/*");
	});

	it("an explicit default_model still outranks the org default", async () => {
		const res = (await executeTool(
			"manage_agents",
			{
				action: "create",
				agent_id: "pinned-over-org-bot",
				name: "Pinned Over Org",
				default_model: "myco/myco-large",
			},
			TEST_ENV,
			ownerCtx,
		)) as { model: ModelInfo };
		expect(res.model.source).toBe("agent");

		const sql = getTestDb();
		const rows = await sql`
			SELECT models FROM agents
			WHERE organization_id = ${orgId} AND id = 'pinned-over-org-bot'
		`;
		expect(rows[0]?.models).toEqual(["myco/myco-large"]);
	});
});
